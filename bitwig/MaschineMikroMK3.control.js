// Maschine Mikro MK3 Controller Script for Bitwig Studio
// Works with the Linux userspace MIDI driver from:
// https://github.com/r00tman/maschine-mikro-mk3-driver
//
// MIDI CC Mapping (from driver):
// - Buttons: CC 20-60 (button index + 20), value 127=press, 0=release
// - Encoder: CC 1 (relative mode: 65+ = CW, <64 = CCW)
// - Slider: CC 9 (0-127)
// - Pads: Notes (configurable in driver config)
//
// === PAD PLAYBACK FEEDBACK ===
// Pads provide visual feedback during clip/sequence playback.
// This feature requires Bitwig Studio 6+ (uses API v18 playingNotes() method).
//
// Customizable settings available in Bitwig Controller Settings:
// - Enable/disable playback feedback
// - Enable/disable manual hit feedback
// - Playback color: Track color (matches track) or Fixed color
// - Choose fixed playback color (Red, Orange, Yellow, Green, Cyan, Blue, Purple, Magenta, White)
// - Choose manual hit color (default: Blue)

// Try API version 18 for Bitwig 6 beta
// If this fails, fall back to 17 which works in Bitwig 5.x
loadAPI(18);

host.defineController("Native Instruments", "Maschine Mikro MK3 (Linux)", "1.0", "e8f4b3a2-1c5d-4e6f-9a8b-7c0d2e3f4a5b");
host.defineMidiPorts(1, 1);
// Bitwig enumerates these as "Virtual Raw MIDI/1" etc (rawmidi), while ALSA sequencer shows
// "Virtual Raw MIDI 1-0" / "VirMIDI 1-0" (aconnect). Support both naming schemes.
host.addDeviceNameBasedDiscoveryPair(["Virtual Raw MIDI/1"], ["Virtual Raw MIDI/1"]);
host.addDeviceNameBasedDiscoveryPair(["Virtual Raw MIDI/1"], ["Virtual Raw MIDI/2"]);
host.addDeviceNameBasedDiscoveryPair(["Virtual Raw MIDI 1-0"], ["Virtual Raw MIDI 1-0"]);
host.addDeviceNameBasedDiscoveryPair(["Virtual Raw MIDI 1-0"], ["Virtual Raw MIDI 1-1"]);
host.addDeviceNameBasedDiscoveryPair(["VirMIDI 1-0"], ["VirMIDI 1-0"]);
host.addDeviceNameBasedDiscoveryPair(["VirMIDI 1-0"], ["VirMIDI 1-1"]);

// Button CC numbers (CC offset + button index)
var CC_OFFSET = 20;

// Button indices matching the driver's Buttons enum
var BTN = {
    MASCHINE: 0,
    STAR: 1,
    BROWSE: 2,
    VOLUME: 3,
    SWING: 4,
    TEMPO: 5,
    PLUGIN: 6,
    SAMPLING: 7,
    LEFT: 8,
    RIGHT: 9,
    PITCH: 10,
    MOD: 11,
    PERFORM: 12,
    NOTES: 13,
    GROUP: 14,
    AUTO: 15,
    LOCK: 16,
    NOTE_REPEAT: 17,
    RESTART: 18,
    ERASE: 19,
    TAP: 20,
    FOLLOW: 21,
    PLAY: 22,
    REC: 23,
    STOP: 24,
    SHIFT: 25,
    FIXED_VEL: 26,
    PAD_MODE: 27,
    KEYBOARD: 28,
    CHORDS: 29,
    STEP: 30,
    SCENE: 31,
    PATTERN: 32,
    EVENTS: 33,
    VARIATION: 34,
    DUPLICATE: 35,
    SELECT: 36,
    SOLO: 37,
    MUTE: 38,
    ENCODER_PRESS: 39,
    ENCODER_TOUCH: 40
};

// CC numbers for other controls
var CC_ENCODER = 1;
var CC_SLIDER = 9;

// State variables
var isShiftPressed = false;
var transport;
var cursorTrack;
var cursorDevice;
var application;
var arranger;
var groove;
var midiOut;

// === LED output is coalesced and sent from flush() ===
var BTN_COUNT = 41;
var desiredButtonLed = [];
var sentButtonLed = [];
var pendingPadLed = {}; // note -> velocity (0..127)
var encoderTouchSuppressUntilMs = 0;

// === Playback note tracking ===
var manualNoteHits = {}; // note -> timestamp of last manual hit
var currentlyPlayingNotes = {}; // note -> true if currently playing from clip
var PAD_NOTES = [48, 49, 50, 51, 44, 45, 46, 47, 40, 41, 42, 43, 36, 37, 38, 39];
var trackPlaybackColor = 4; // Default to red, will be updated based on track color

// === User preferences ===
var preferences;
var enablePlaybackFeedback;
var enableManualFeedback;
var playbackColorMode;
var fixedPlaybackColor;
var manualHitColor;

// Pad color mapping (velocity ranges from driver)
var PAD_COLORS = {
    RED: 4,           // 1-7
    ORANGE: 11,       // 8-14
    LIGHT_ORANGE: 18, // 15-21
    WARM_YELLOW: 25,  // 22-28
    YELLOW: 32,       // 29-35
    LIME: 39,         // 36-42
    GREEN: 46,        // 43-49
    MINT: 53,         // 50-56
    CYAN: 60,         // 57-63
    TURQUOISE: 67,    // 64-70
    BLUE: 74,         // 71-77
    PLUM: 81,         // 78-84
    VIOLET: 88,       // 85-91
    PURPLE: 95,       // 92-98
    MAGENTA: 102,     // 99-105
    FUCHSIA: 109,     // 106-112
    WHITE: 120        // 113-127
};

function init() {
    midiOut = host.getMidiOutPort(0);

    for (var i = 0; i < BTN_COUNT; i++) {
        desiredButtonLed[i] = 0;
        sentButtonLed[i] = -1; // force send on first flush
    }

    // === Setup user preferences ===
    preferences = host.getPreferences();
    
    // Playback feedback enable/disable
    enablePlaybackFeedback = preferences.getEnumSetting(
        "Playback Feedback",
        "Pad LEDs",
        ["Enabled", "Disabled"],
        "Enabled"
    );
    enablePlaybackFeedback.markInterested();
    
    // Manual hit feedback enable/disable
    enableManualFeedback = preferences.getEnumSetting(
        "Manual Hit Feedback",
        "Pad LEDs",
        ["Enabled", "Disabled"],
        "Enabled"
    );
    enableManualFeedback.markInterested();
    
    // Playback color mode: track color or fixed color
    playbackColorMode = preferences.getEnumSetting(
        "Playback Color Mode",
        "Pad LEDs",
        ["Track Color", "Fixed Color"],
        "Track Color"
    );
    playbackColorMode.markInterested();
    
    // Fixed playback color selection
    fixedPlaybackColor = preferences.getEnumSetting(
        "Fixed Playback Color",
        "Pad LEDs",
        ["Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Magenta", "White"],
        "Red"
    );
    fixedPlaybackColor.markInterested();
    
    // Manual hit color selection
    manualHitColor = preferences.getEnumSetting(
        "Manual Hit Color",
        "Pad LEDs",
        ["Red", "Orange", "Yellow", "Green", "Cyan", "Blue", "Purple", "Magenta", "White"],
        "Blue"
    );
    manualHitColor.markInterested();

    // Create Bitwig API objects
    transport = host.createTransport();
    cursorTrack = host.createCursorTrack("MaschineMikro", "Cursor Track", 0, 0, true);
    cursorDevice = cursorTrack.createCursorDevice();
    application = host.createApplication();
    arranger = host.createArranger();
    groove = host.createGroove();

    // Set up observers for LED feedback
    transport.addIsPlayingObserver(function(isPlaying) {
        setButtonLed(BTN.PLAY, isPlaying ? 127 : 0);
    });

    var recordValue = transport.isArrangerRecordEnabled();
    recordValue.markInterested();
    recordValue.addValueObserver(function(value) {
        setButtonLed(BTN.REC, value ? 127 : 0);
    });

    // For other transport states, use the property-based observers with markInterested
    var loopValue = transport.isArrangerLoopEnabled();
    loopValue.markInterested();
    loopValue.addValueObserver(function(value) {
        setButtonLed(BTN.RESTART, value ? 127 : 0);
    });

    var metronomeValue = transport.isMetronomeEnabled();
    metronomeValue.markInterested();
    metronomeValue.addValueObserver(function(value) {
        setButtonLed(BTN.TAP, value ? 127 : 0);
    });

    var automationValue = transport.isArrangerAutomationWriteEnabled();
    automationValue.markInterested();
    automationValue.addValueObserver(function(value) {
        setButtonLed(BTN.AUTO, value ? 127 : 0);
    });

    // Track observers
    var soloValue = cursorTrack.solo();
    soloValue.markInterested();
    soloValue.addValueObserver(function(value) {
        setButtonLed(BTN.SOLO, value ? 127 : 0);
    });

    var muteValue = cursorTrack.mute();
    muteValue.markInterested();
    muteValue.addValueObserver(function(value) {
        setButtonLed(BTN.MUTE, value ? 127 : 0);
    });

    var armValue = cursorTrack.arm();
    armValue.markInterested();
    armValue.addValueObserver(function(value) {
        setButtonLed(BTN.SAMPLING, value ? 127 : 0);
    });

    // Observe track color to match playback feedback
    var trackColor = cursorTrack.color();
    trackColor.markInterested();
    trackColor.addValueObserver(function(red, green, blue) {
        // Map RGB to closest pad color
        var newColor = rgbToPadColor(red, green, blue);
        if (newColor !== trackPlaybackColor) {
            trackPlaybackColor = newColor;
            println("Track color changed - playback pads will use velocity " + trackPlaybackColor);
        }
    });

    // Create note input for pads to pass through to instruments
    var noteInput = host.getMidiInPort(0).createNoteInput("Maschine Pads", "8?????", "9?????", "D?????");
    noteInput.setShouldConsumeEvents(false);

    // === Setup playback note feedback ===
    // This observer tracks notes currently playing from clips/sequences
    if (typeof cursorTrack.playingNotes === 'function') {
        var trackPlayingNotes = cursorTrack.playingNotes();
        trackPlayingNotes.addValueObserver(function(notes) {
            // Check if playback feedback is enabled
            if (enablePlaybackFeedback.get() === "Disabled") {
                // Clear all playback notes when disabled
                currentlyPlayingNotes = {};
                return;
            }
            
            // Clear tracking map
            currentlyPlayingNotes = {};
            
            // Build set of currently playing notes
            if (notes && notes.length > 0) {
                for (var i = 0; i < notes.length; i++) {
                    var playingNote = notes[i];
                    var pitch = -1;
                    
                    // Extract MIDI pitch from PlayingNote object
                    if (typeof playingNote.pitch === 'function') {
                        pitch = playingNote.pitch();
                    } else if (typeof playingNote.key === 'function') {
                        pitch = playingNote.key();
                    } else if (playingNote.pitch !== undefined) {
                        pitch = playingNote.pitch;
                    } else if (playingNote.key !== undefined) {
                        pitch = playingNote.key;
                    }
                    
                    if (pitch >= 0) {
                        currentlyPlayingNotes[pitch] = true;
                    }
                }
            }
            
            // Update pad LEDs based on playback state
            for (var j = 0; j < PAD_NOTES.length; j++) {
                var note = PAD_NOTES[j];
                
                if (currentlyPlayingNotes[note]) {
                    // Note is playing from clip - use configured color
                    setPadLed(note, getPlaybackColor());
                } else {
                    // Note not playing - turn off (unless recently manually hit)
                    var lastManualHit = manualNoteHits[note] || 0;
                    if (Date.now() - lastManualHit > 50) {
                        setPadLed(note, 0);
                    }
                }
            }
        });
        println("Playback note feedback enabled");
    } else {
        println("WARNING: playingNotes() not available - requires Bitwig 6+");
    }

    // Set up MIDI callback for manual pad hits
    host.getMidiInPort(0).setMidiCallback(onMidi);

    // Initialize LEDs
    host.scheduleTask(function() {
        // Dim "Maschine" to show connected
        setButtonLed(BTN.MASCHINE, 42);
    }, 100);

    println("Maschine Mikro MK3 (Linux) initialized with playback feedback");
}

function setButtonLed(buttonIndex, value) {
    // Value is interpreted by the driver as brightness:
    // 1-42 dim, 43-84 normal, 85-127 bright, 0 off
    if (buttonIndex < 0 || buttonIndex >= BTN_COUNT) return;
    desiredButtonLed[buttonIndex] = value;
}

function sendButtonLedNow(buttonIndex, value) {
    var cc = CC_OFFSET + buttonIndex;
    midiOut.sendMidi(0xB0, cc, value);
}

function setPadLed(note, velocity) {
    pendingPadLed[note] = velocity;
}

function flushPadLed() {
    // Send pending pad LED updates, then clear. Keep it small to avoid flooding.
    for (var noteStr in pendingPadLed) {
        var note = parseInt(noteStr, 10);
        var vel = pendingPadLed[noteStr] | 0;
        if (vel > 0) {
            midiOut.sendMidi(0x90, note, vel);
        } else {
            midiOut.sendMidi(0x80, note, 0);
        }
    }
    pendingPadLed = {};
}

function getColorFromName(colorName) {
    // Convert color name from preferences to pad color velocity
    switch (colorName) {
        case "Red": return PAD_COLORS.RED;
        case "Orange": return PAD_COLORS.ORANGE;
        case "Yellow": return PAD_COLORS.YELLOW;
        case "Green": return PAD_COLORS.GREEN;
        case "Cyan": return PAD_COLORS.CYAN;
        case "Blue": return PAD_COLORS.BLUE;
        case "Purple": return PAD_COLORS.PURPLE;
        case "Magenta": return PAD_COLORS.MAGENTA;
        case "White": return PAD_COLORS.WHITE;
        default: return PAD_COLORS.RED;
    }
}

function getPlaybackColor() {
    // Get playback color based on user preferences
    if (playbackColorMode.get() === "Fixed Color") {
        return getColorFromName(fixedPlaybackColor.get());
    } else {
        return trackPlaybackColor; // Track color
    }
}

function getManualColor() {
    // Get manual hit color based on user preferences
    return getColorFromName(manualHitColor.get());
}

function rgbToPadColor(red, green, blue) {
    // Bitwig provides RGB as floats (0.0 to 1.0)
    // Map to closest pad color based on hue and saturation
    
    // Convert to 0-255 range
    var r = Math.round(red * 255);
    var g = Math.round(green * 255);
    var b = Math.round(blue * 255);
    
    // Calculate HSV to determine color
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var diff = max - min;
    
    // Saturation
    var sat = (max === 0) ? 0 : diff / max;
    
    // Low saturation = white/gray
    if (sat < 0.2) {
        return PAD_COLORS.WHITE;
    }
    
    // Hue calculation
    var hue = 0;
    if (diff !== 0) {
        if (max === r) {
            hue = 60 * (((g - b) / diff) % 6);
        } else if (max === g) {
            hue = 60 * (((b - r) / diff) + 2);
        } else {
            hue = 60 * (((r - g) / diff) + 4);
        }
    }
    if (hue < 0) hue += 360;
    
    // Map hue to pad colors
    if (hue < 15 || hue >= 345) return PAD_COLORS.RED;
    if (hue < 30) return PAD_COLORS.ORANGE;
    if (hue < 45) return PAD_COLORS.WARM_YELLOW;
    if (hue < 70) return PAD_COLORS.YELLOW;
    if (hue < 90) return PAD_COLORS.LIME;
    if (hue < 150) return PAD_COLORS.GREEN;
    if (hue < 165) return PAD_COLORS.MINT;
    if (hue < 180) return PAD_COLORS.CYAN;
    if (hue < 195) return PAD_COLORS.TURQUOISE;
    if (hue < 240) return PAD_COLORS.BLUE;
    if (hue < 270) return PAD_COLORS.VIOLET;
    if (hue < 300) return PAD_COLORS.PURPLE;
    if (hue < 320) return PAD_COLORS.MAGENTA;
    return PAD_COLORS.FUCHSIA;
}

function decodeRelativeEncoder(value) {
    // The driver sends encoder CC in "offset binary" relative mode:
    // value = 64 + delta, where delta is signed.
    // Examples: 65 => +1, 63 => -1, 59 => -5, 71 => +7.
    //
    // Note: Some controllers use "relative1" (1..63 CW, 65..127 CCW). We do NOT
    // use that here because it makes downwards turns (values < 64) decode wrong.
    if (value === 0 || value === 64) return 0;
    return value - 64;
}

function onMidi(status, data1, data2) {
    var msgType = status & 0xF0;

    if (msgType === 0xB0) {
        onCC(data1, data2);
        return;
    }

    // Pad note events - provide immediate visual feedback for manual hits
    // Notes also pass through via noteInput to instruments
    if (msgType === 0x90) {
        if (data2 > 0) {
            // Note on - track manual hit
            manualNoteHits[data1] = Date.now();
            
            // Show manual feedback if enabled and not currently playing from clip
            if (enableManualFeedback.get() === "Enabled" && !currentlyPlayingNotes[data1]) {
                setPadLed(data1, getManualColor());
            }
        } else {
            // Note on with velocity 0 = note off
            // Turn off unless playing from clip
            if (!currentlyPlayingNotes[data1]) {
                setPadLed(data1, 0);
            }
        }
        return;
    }
    if (msgType === 0x80) {
        // Explicit note off - turn off unless playing from clip
        if (!currentlyPlayingNotes[data1]) {
            setPadLed(data1, 0);
        }
        return;
    }
}

function onCC(cc, value) {
    var isPressed = value > 0;

    // Button CCs (20-60)
    if (cc >= CC_OFFSET && cc < CC_OFFSET + 41) {
        var buttonIndex = cc - CC_OFFSET;
        onButton(buttonIndex, isPressed, value);
        return;
    }

    // Encoder rotation (CC 1)
    if (cc === CC_ENCODER) {
        // Suppress spurious encoder ticks right after capacitive touch engages.
        if (Date.now() < encoderTouchSuppressUntilMs) return;
        var delta = decodeRelativeEncoder(value);
        onEncoder(delta);
        return;
    }

    // Slider (CC 9)
    if (cc === CC_SLIDER) {
        onSlider(value);
        return;
    }
}

function onButton(button, pressed, value) {
    // Track encoder touch to suppress spurious encoder ticks
    if (button === BTN.ENCODER_TOUCH) {
        if (pressed) {
            encoderTouchSuppressUntilMs = Date.now() + 120;
        }
        return;
    }

    // Track shift state
    if (button === BTN.SHIFT) {
        isShiftPressed = pressed;
        setButtonLed(BTN.SHIFT, pressed ? 127 : 0);
        return;
    }

    // Only act on button press, not release
    if (!pressed) return;

    switch (button) {
        // === TRANSPORT ===
        case BTN.PLAY:
            if (isShiftPressed) {
                transport.returnToArrangement();
            } else {
                transport.togglePlay();
            }
            break;

        case BTN.STOP:
            if (isShiftPressed) {
                transport.resetAutomationOverrides();
            } else {
                transport.stop();
            }
            break;

        case BTN.REC:
            if (isShiftPressed) {
                transport.isArrangerOverdubEnabled().toggle();
            } else {
                transport.isArrangerRecordEnabled().toggle();
            }
            break;

        case BTN.RESTART:
            if (isShiftPressed) {
                transport.isArrangerLoopEnabled().toggle();
            } else {
                transport.jumpToPlayStartPosition();
            }
            break;

        case BTN.TAP:
            if (isShiftPressed) {
                transport.isMetronomeEnabled().toggle();
            } else {
                transport.tapTempo();
            }
            break;

        case BTN.TEMPO:
            if (isShiftPressed) {
                // Could open tempo panel
            } else {
                transport.tapTempo();
            }
            break;

        // === NAVIGATION ===
        case BTN.LEFT:
            if (isShiftPressed) {
                cursorTrack.selectPrevious();
            } else {
                transport.rewind();
            }
            break;

        case BTN.RIGHT:
            if (isShiftPressed) {
                cursorTrack.selectNext();
            } else {
                transport.fastForward();
            }
            break;

        case BTN.ENCODER_PRESS:
            if (isShiftPressed) {
                cursorTrack.selectInMixer();
            } else {
                cursorTrack.selectInEditor();
            }
            break;

        // === BROWSER ===
        case BTN.BROWSE:
            if (isShiftPressed) {
                cursorDevice.browseToInsertAfterDevice();
            } else {
                application.toggleBrowserVisibility();
            }
            break;

        // === TRACK CONTROLS ===
        case BTN.SOLO:
            cursorTrack.solo().toggle();
            break;

        case BTN.MUTE:
            cursorTrack.mute().toggle();
            break;

        case BTN.SELECT:
            cursorTrack.selectInMixer();
            break;

        case BTN.SAMPLING:
            cursorTrack.arm().toggle();
            break;

        // === EDITING ===
        case BTN.DUPLICATE:
            if (isShiftPressed) {
                application.duplicateObject();
            } else {
                application.duplicate();
            }
            break;

        case BTN.ERASE:
            if (isShiftPressed) {
                application.cut();
            } else {
                application.remove();
            }
            break;

        case BTN.VOLUME:
            if (isShiftPressed) {
                application.redo();
            } else {
                application.undo();
            }
            break;

        // === DEVICE NAVIGATION ===
        case BTN.PLUGIN:
            if (isShiftPressed) {
                cursorDevice.selectPrevious();
            } else {
                cursorDevice.selectNext();
            }
            break;

        case BTN.GROUP:
            if (isShiftPressed) {
                cursorDevice.selectParent();
            } else {
                cursorTrack.selectParent();
            }
            break;

        // === VIEW TOGGLES ===
        case BTN.KEYBOARD:
            application.toggleNoteEditor();
            break;

        case BTN.STEP:
            if (isShiftPressed) {
                application.toggleAutomationEditor();
            } else {
                application.toggleNoteEditor();
            }
            break;

        case BTN.SCENE:
            application.toggleMixer();
            break;

        case BTN.PATTERN:
            if (isShiftPressed) {
                transport.returnToArrangement();
            } else {
                application.focusPanelBelow();
            }
            break;

        case BTN.EVENTS:
            if (isShiftPressed) {
                arranger.toggleClipLauncher();
            } else {
                application.toggleDevices();
            }
            break;

        // === AUTOMATION ===
        case BTN.AUTO:
            if (isShiftPressed) {
                transport.resetAutomationOverrides();
            } else {
                transport.isArrangerAutomationWriteEnabled().toggle();
            }
            break;

        case BTN.FOLLOW:
            if (isShiftPressed) {
                application.zoomToFit();
            } else {
                // Note: Follow playback is not exposed in the Bitwig API
                // Using zoom to selection as alternative
                application.zoomToSelection();
            }
            break;

        // === GROOVE / SWING ===
        case BTN.SWING:
            if (isShiftPressed) {
                groove.getEnabled().toggle();
            } else {
                // Could show groove panel
                host.showPopupNotification("Swing: Use encoder to adjust");
            }
            break;

        // === UTILITY ===
        case BTN.STAR:
            if (isShiftPressed) {
                application.selectAll();
            } else {
                application.selectNone();
            }
            break;

        case BTN.LOCK:
            if (isShiftPressed) {
                cursorTrack.isPinned().toggle();
            } else {
                cursorDevice.isPinned().toggle();
            }
            break;

        case BTN.NOTE_REPEAT:
            // Note repeat would need arpeggiator device
            host.showPopupNotification("Note Repeat: N/A");
            break;

        case BTN.FIXED_VEL:
            // Fixed velocity could control note input velocity
            host.showPopupNotification("Fixed Velocity: N/A");
            break;

        case BTN.PAD_MODE:
            if (isShiftPressed) {
                application.toggleDevices();
            } else {
                application.toggleNoteEditor();
            }
            break;

        case BTN.CHORDS:
            host.showPopupNotification("Chords: N/A");
            break;

        case BTN.VARIATION:
            if (isShiftPressed) {
                application.paste();
            } else {
                application.copy();
            }
            break;

        case BTN.PERFORM:
            application.toggleFullScreen();
            break;

        case BTN.NOTES:
            application.toggleInspector();
            break;

        case BTN.PITCH:
            // Could control pitch bend range
            break;

        case BTN.MOD:
            // Could control modulation
            break;

        case BTN.MASCHINE:
            if (isShiftPressed) {
                host.showPopupNotification("Maschine Mikro MK3 (Linux Driver)");
            } else {
                application.toggleInspector();
            }
            break;
    }
}

function onEncoder(delta) {
    // Filter out noise and cap large deltas
    if (delta === 0) return;
    if (delta > 8) delta = 8;
    if (delta < -8) delta = -8;

    if (isShiftPressed) {
        // Tempo adjustment
        transport.tempo().incRaw(delta);
    } else {
        // Navigate tracks
        var steps = Math.min(8, Math.abs(delta));
        for (var i = 0; i < steps; i++) {
            if (delta > 0) {
                cursorTrack.selectNext();
            } else {
                cursorTrack.selectPrevious();
            }
        }
    }
}

function onSlider(value) {
    if (isShiftPressed) {
        // Master volume or crossfader
        // Would need master track: host.createMasterTrack(0).volume().set(value, 128);
    } else {
        // Current track volume
        cursorTrack.volume().set(value, 128);
    }
}

function flush() {
    // Coalesced LED + pad feedback output
    for (var i = 0; i < BTN_COUNT; i++) {
        var v = desiredButtonLed[i];
        if (sentButtonLed[i] !== v) {
            sendButtonLedNow(i, v);
            sentButtonLed[i] = v;
        }
    }
    flushPadLed();
}

function exit() {
    // Turn off all LEDs on exit
    for (var i = 0; i < BTN_COUNT; i++) {
        sendButtonLedNow(i, 0);
    }
    // Turn off all pads
    for (var j = 0; j < PAD_NOTES.length; j++) {
        midiOut.sendMidi(0x80, PAD_NOTES[j], 0);
    }
    println("Maschine Mikro MK3 Controller Script unloaded");
}
