/**
 * @file
 * @brief DEV-04 trusted keyboard focus classification for the native shortcut-combo channel.
 *
 * The global `key-combo` channel exists so the recording HUD can show shortcut capsules while
 * another application is focused. A combo label is not typed text, but the focus *context* is
 * privacy-sensitive: the same Ctrl+V can be a deliberate demo shortcut or a paste into a
 * password field, and the JavaScript side is not allowed to invent that context (a payload from
 * the renderer/main process is untrusted). The classification therefore happens at the native
 * capture boundary and it fails closed: only a positively identified non-text application
 * surface may emit a combo.
 *
 * Evidence -> class rules (ClassifyKeyboardFocus):
 *  - no foreground snapshot / focus moved since the event / own process / no UIA element /
 *    bounded UIA probe timed out                      -> Unknown (drop the event)
 *  - UIA IsPassword                                     -> Password (drop)
 *  - an active IME composition                          -> ImeComposition (drop)
 *  - UIA Edit control type or writable ValuePattern     -> TextInput (drop)
 *  - anything else that produced a UIA element          -> Safe (accept)
 *
 * The policy below is pure over a value-only evidence struct (same approach as
 * ClassifyKeyboardCombo in keyboard_combo.h): no OS calls, no UIA, no allocation, so the Node
 * self-test bridge can drive the exact production classifier deterministically. The runtime
 * evidence collector lives in keyboard_focus.cc: the low-level hook only snapshots the event-time
 * foreground/focus window handles, and the bounded UIA probe runs later on the JavaScript thread
 * (never in the hook callback).
 */
#pragma once

#include <windows.h>

#include <memory>

namespace highlighter
{

/** @brief Trusted focus classes for the shortcut-combo channel. */
enum class KeyboardFocusClass
{
    Safe,
    Password,
    TextInput,
    ImeComposition,
    Unknown
};

/**
 * @brief Value-only focus evidence gathered by the runtime probe.
 * @note Constructed off the hook thread. The pure policy only reads these booleans so every
 * class can be asserted from a headless Node process.
 */
struct KeyboardFocusEvidence
{
    bool foregroundAlive = false;      ///< Event-time foreground window still exists.
    bool foregroundIsCurrent = false;  ///< It is still the foreground window now.
    bool ownProcess = false;           ///< The event-time foreground belongs to this process.
    bool classifierAvailable = true;   ///< The bounded IUIAutomation2 client could be created.
    bool probeTimedOut = false;        ///< A bounded UIA call exceeded the classification budget.
    bool elementAvailable = false;     ///< A UIA element for the focus owner was obtained.
    bool isPassword = false;           ///< UIA_IsPasswordPropertyId of the focus owner.
    bool isTextEditControl = false;    ///< UIA_EditControlTypeId for the focus owner.
    bool hasWritableValue = false;     ///< ValuePattern is available and not read-only.
    bool imeComposing = false;         ///< An IME composition string is active.
};

struct KeyboardFocusDecision
{
    KeyboardFocusClass classification = KeyboardFocusClass::Unknown;
    const char *reason = "unknown";  ///< Stable ASCII reason for tests and diagnostics.
};

/** @return true only for the single class that may emit a shortcut combo. */
inline bool IsKeyboardFocusSafe(KeyboardFocusClass classification)
{
    return classification == KeyboardFocusClass::Safe;
}

/** @return the stable JavaScript-facing context name ("safe"/"password"/"text"/"ime"/"unknown"). */
inline const char *KeyboardFocusClassName(KeyboardFocusClass classification)
{
    switch (classification)
    {
        case KeyboardFocusClass::Safe:
            return "safe";
        case KeyboardFocusClass::Password:
            return "password";
        case KeyboardFocusClass::TextInput:
            return "text";
        case KeyboardFocusClass::ImeComposition:
            return "ime";
        case KeyboardFocusClass::Unknown:
            return "unknown";
    }
    return "unknown";
}

/**
 * @brief Classify one focus evidence snapshot for the opt-in shortcut-combo channel.
 * @param[in] evidence Value-only evidence gathered by keyboard_focus.cc or a self-test.
 * @return Safe (the only accepted class) or a rejected class with a stable reason.
 * @warning Changing the accept set reopens the "no shortcut labels from sensitive focus"
 * guarantee; re-run the native focus policy tests and the focus-context probe.
 */
inline KeyboardFocusDecision ClassifyKeyboardFocus(const KeyboardFocusEvidence &evidence)
{
    KeyboardFocusDecision rejected;
    rejected.classification = KeyboardFocusClass::Unknown;

    // Fail closed first: every one of these means "we cannot prove the surface is safe".
    if (!evidence.foregroundAlive)
    {
        rejected.reason = "no_foreground";
        return rejected;
    }
    if (!evidence.foregroundIsCurrent)
    {
        rejected.reason = "foreground_changed";
        return rejected;
    }
    if (evidence.ownProcess)
    {
        // Our own window is covered by the control-bar DOM path; the native channel must not
        // double-report it and must never classify an unknown own-process surface as safe.
        rejected.reason = "own_process";
        return rejected;
    }
    if (!evidence.classifierAvailable)
    {
        rejected.reason = "classifier_unavailable";
        return rejected;
    }
    if (evidence.probeTimedOut)
    {
        rejected.reason = "probe_timeout";
        return rejected;
    }
    if (!evidence.elementAvailable)
    {
        rejected.reason = "no_focus_element";
        return rejected;
    }

    // Sensitive classes take precedence over the safe fallback.
    if (evidence.isPassword)
    {
        rejected.classification = KeyboardFocusClass::Password;
        rejected.reason = "password_focus";
        return rejected;
    }
    if (evidence.imeComposing)
    {
        rejected.classification = KeyboardFocusClass::ImeComposition;
        rejected.reason = "ime_composition";
        return rejected;
    }
    if (evidence.isTextEditControl || evidence.hasWritableValue)
    {
        rejected.classification = KeyboardFocusClass::TextInput;
        rejected.reason = evidence.isTextEditControl ? "text_edit_focus" : "writable_value_focus";
        return rejected;
    }

    KeyboardFocusDecision accepted;
    accepted.classification = KeyboardFocusClass::Safe;
    accepted.reason = "safe_focus";
    return accepted;
}

//=============================================================================
// Runtime evidence collector (Win32/UIA). Never used from the hook callback.
//=============================================================================

/**
 * @brief Cheap event-time focus snapshot captured inside the low-level hook callback.
 * @note Captured with GetForegroundWindow/GetWindowThreadProcessId/GetGUIThreadInfo only. These
 * are cheap, do not dispatch messages and cannot block on a hung application, which keeps the
 * WH_KEYBOARD_LL callback inside the LowLevelHooksTimeout budget.
 */
struct KeyboardFocusSnapshot
{
    HWND foregroundWindow = nullptr;
    HWND focusWindow = nullptr;  ///< GUITHREADINFO.hwndFocus of the foreground thread, if any.
    DWORD processId = 0;
    bool valid = false;
};

/**
 * @brief Snapshot the current foreground/focus window for one key event.
 * @return Value-only snapshot; valid=false when no foreground window is available.
 * @warning Cheap and non-blocking by contract: call from the hook callback, nothing else.
 */
KeyboardFocusSnapshot CaptureKeyboardFocusSnapshot();

/**
 * @brief Bounded UIA focus classifier for the shortcut-combo channel.
 *
 * Owns one IUIAutomation2 client created on first use. All methods must be called from the
 * thread that uses the object (the JavaScript thread for the production path; the test thread
 * for the self-test bridge); the client is created, used and released on that same thread.
 *
 * @warning The IUIAutomation2 timeouts are the safety boundary for a hung accessibility
 * provider. A plain IUIAutomation client cannot prove that bound, so creation fails closed and
 * every combo is rejected instead of risking a blocked main thread.
 */
class KeyboardFocusClassifier
{
  public:
    KeyboardFocusClassifier();
    ~KeyboardFocusClassifier();

    KeyboardFocusClassifier(const KeyboardFocusClassifier &) = delete;
    KeyboardFocusClassifier &operator=(const KeyboardFocusClassifier &) = delete;

    /**
     * @brief Production classification of an event-time snapshot.
     * @param[in] snapshot Cheap hook-time snapshot of the foreground/focus windows.
     * @return Safe only for a positively classified non-text surface; Unknown on any failure.
     */
    KeyboardFocusDecision ClassifyForeground(const KeyboardFocusSnapshot &snapshot);

    /**
     * @brief Classify a specific window/control handle (deterministic probe path).
     * @param[in] window Window or child control handle to classify directly.
     * @return Same policy as ClassifyForeground, but the handle is the explicit target instead
     * of the current focused element. Used by __testClassifyFocusedContext with a handle so an
     * automation probe can classify an off-screen test window without pressing keys.
     */
    KeyboardFocusDecision ClassifyWindowHandle(HWND window);

    /** @return true when the bounded UIA client was created successfully. */
    bool IsAvailable();

    /** @brief Release the UIA client; safe no-op when it was never created. */
    void Reset();

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace highlighter
