// Maschine Mikro MK3 Controller Script for Bitwig Studio
// Works with the Linux userspace MIDI driver from:
// https://github.com/r00tman/maschine-mikro-mk3-driver
//
// MIDI CC Mapping (from driver):
// - Buttons: CC 20-60 (button index + 20), value 127=press, 0=release
// - Encoder: CC 1 (relative mode: 65+ = CW, <64 = CCW)
// - Slider: CC 9 (0-127)
// - Pads: Notes (configurable in driver config)

loadAPI(17);

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

function init() {
    host.getMidiInPort(0).setMidiCallback(onMidi);
    midiOut = host.getMidiOutPort(0);

    for (var i = 0; i < BTN_COUNT; i++) {
        desiredButtonLed[i] = 0;
        sentButtonLed[i] = -1; // force send on first flush
    }

    // Create Bitwig API objects
    transport = host.createTransport();
    cursorTrack = host.createCursorTrack("MaschineMikro", "Cursor Track", 0, 0, true);
    cursorDevice = cursorTrack.createCursorDevice();
    application = host.createApplication();
    arranger = host.createArranger();
    groove = host.createGroove();

    // Set up observers for LED feedback using direct observer methods
    transport.addIsPlayingObserver(function(isPlaying) {
        println("PLAY observer: " + isPlaying);
        setButtonLed(BTN.PLAY, isPlaying ? 127 : 0);
    });

    // For record, use the property-based observer to match how we toggle it
    var recordValue = transport.isArrangerRecordEnabled();
    recordValue.markInterested();
    recordValue.addValueObserver(function(value) {
        println("REC observer: " + value);
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

    // Create note input for pads to pass through to instruments
    var noteInput = host.getMidiInPort(0).createNoteInput("Maschine Pads", "8?????", "9?????", "D?????");
    noteInput.setShouldConsumeEvents(false);

    // Initialize LEDs
    host.scheduleTask(function() {
        // Dim "Maschine" to show connected
        setButtonLed(BTN.MASCHINE, 42);
    }, 100);

    println("Maschine Mikro MK3 (Linux) initialized");
}

function setButtonLed(buttonIndex, value) {
    // Value is interpreted by the driver as brightness:
    // 1-42 dim, 43-84 normal, 85-127 bright, 0 off
    if (buttonIndex < 0 || buttonIndex >= BTN_COUNT) return;
    println("setButtonLed: btn=" + buttonIndex + " val=" + value);
    desiredButtonLed[buttonIndex] = value;
}

function sendButtonLedNow(buttonIndex, value) {
    var cc = CC_OFFSET + buttonIndex;
    println("sendButtonLedNow: btn=" + buttonIndex + " cc=" + cc + " val=" + value);
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

    // Pad note events (for LED echo). Notes also pass through via noteInput.
    if (msgType === 0x90) {
        if (data2 > 0) {
            // Blue-ish range in the driver: 71-77 = Blue. Use 76.
            setPadLed(data1, 76);
        } else {
            setPadLed(data1, 0);
        }
        return;
    }
    if (msgType === 0x80) {
        setPadLed(data1, 0);
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
    // Track encoder touch to suppress spurious encoder ticks.
    if (button === BTN.ENCODER_TOUCH) {
        if (pressed) {
            encoderTouchSuppressUntilMs = Date.now() + 120;
        }
        return;
    }

    // Track shift state (don't act on press/release, just track it)
    if (button === BTN.SHIFT) {
        isShiftPressed = pressed;
        // Shift LED is immediate so it feels responsive.
        setButtonLed(BTN.SHIFT, pressed ? 127 : 0);
        return;
    }

    // Only act on button press, not release (except for specific buttons)
    if (!pressed) return;

    switch (button) {
        // === TRANSPORT ===
        case BTN.PLAY:
            println("PLAY button pressed");
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

var flushCounter = 0;
function flush() {
    flushCounter++;
    if (flushCounter % 100 === 1) {
        println("flush() called, count=" + flushCounter);
    }
    
    // Coalesced LED + pad feedback output.
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
    for (var i = 0; i < 41; i++) {
        sendButtonLedNow(i, 0);
    }
    println("Maschine Mikro MK3 Controller Script unloaded");
}
