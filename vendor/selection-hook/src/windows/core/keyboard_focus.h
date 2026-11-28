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
 * Evidence -> class rules (ClassifyKeyboardFocus), in this order:
 *  1. no foreground snapshot / focus moved since the event / own process / classifier
 *     unavailable / bounded UIA probe timed out / no UIA element   -> Unknown (drop)
 *  2. UIA IsPassword                                               -> Password (drop)
 *  3. an active IME composition                                    -> ImeComposition (drop)
 *  4. UIA Edit control type, a writable ValuePattern or a writable TextPattern
 *     (Word/RichEdit/custom editors)                               -> TextInput (drop)
 *  5. focus identity not confirmed (evidence came from the ElementFromHandle fallback and may
 *     describe the host container of virtual subcontrols)          -> Unknown (drop)
 *  6. ValuePattern/TextPattern exists but its read-only answer could not be read
 *     (property-read failure)                                      -> Unknown (drop)
 *  7. positively confirmed read-only ValuePattern/TextPattern
 *     (browser demo page, read-only editors)                       -> Safe (accept)
 *  8. positively confirmed non-text control: no ValuePattern/TextPattern and the control type is
 *     not Document/Text                                            -> Safe (accept)
 *  9. anything else (e.g. Document/Text without read-only evidence) -> Unknown (drop)
 *
 * P1-3 (docs/reviews/2026-11-28-d7923ac-fix-delivery-review.md section 3): a successful
 * get_CurrentControlType/get_CurrentIsPassword only proves that the element is readable. Missing
 * writability evidence is no longer treated as safety: a present pattern without a read-only
 * answer, or an element that may be a container of virtual subcontrols, fails closed.
 *
 * Residual uncertainty (deliberate, documented instead of silently accepted):
 *  - The TextPattern rule needs the provider to answer UIA_IsReadOnlyAttributeId on its document
 *    range. A provider that cannot answer it now yields Unknown (fail closed) instead of the old
 *    weaker accept rule; providers without TextPattern stay on rule 8.
 *  - Classification runs on the drained TSFN event, up to the wall-clock budget after the key
 *    press. A post-probe re-check proves foreground and native focus did not change during the
 *    probe; a same-window web-content focus change that does not move the native focus HWND
 *    remains a residual risk.
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
    bool elementAvailable = false;     ///< Control type + password flag of the UIA element were read.
    /// Evidence provenance. True only for a matching GetFocusedElement result (or an explicit
    /// caller-chosen handle). The ElementFromHandle fallback may describe the host container of
    /// virtual subcontrols, so it cannot authorize Safe.
    bool focusIdentityConfirmed = false;
    bool isPassword = false;      ///< UIA_IsPasswordPropertyId of the focus owner.
    bool isTextEditControl = false;  ///< UIA_EditControlTypeId for the focus owner.
    bool isTextControlType = false;  ///< UIA_DocumentControlTypeId / UIA_TextControlTypeId.
    // Pattern presence is recorded separately from the read-only answer: a pattern that exists
    // but whose read-only property could not be read is ambiguous (Unknown), never safe.
    bool valuePatternPresent = false;       ///< A ValuePattern was obtained for the element.
    bool valueReadOnlyKnown = false;        ///< ValuePattern::get_CurrentIsReadOnly succeeded.
    bool valueReadOnly = false;             ///< ValuePattern reports IsReadOnly=TRUE (valid when known).
    bool textPatternPresent = false;        ///< A TextPattern was obtained for the element.
    bool textPatternReadOnlyKnown = false;  ///< DocumentRange answered UIA_IsReadOnlyAttributeId.
    bool textPatternReadOnly = false;       ///< DocumentRange reports IsReadOnly=TRUE (valid when known).
    // Compatibility mirrors filled by the same reads. The policy OR-checks them with the
    // value-domain fields above, so neither "pattern present but unreadable" nor an old-style
    // writable flag can ever collapse into "not writable".
    bool hasWritableValue = false;     ///< ValuePattern present and known writable (legacy mirror).
    bool textPatternWritable = false;  ///< TextPattern present and known writable (legacy mirror).
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
        // Defence-in-depth only. The selection hook is loaded by the recording utility process,
        // so the product's control-bar window belongs to the MAIN process and has a different
        // PID: this branch does not cover or suppress it. A physical press that both the control
        // bar (DOM keydown) and the global hook report is collapsed to one event by the P2-06
        // source-aware pairing in main/domains/record/index.js, not by this rule. Keep the branch
        // so a surface of the utility process itself can never be classified Safe.
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

    // Sensitive classes take precedence over the safe fallback. A password/IME/writable-text
    // rejection does not depend on how much focus identity was proven.
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
    const bool writableValue = evidence.hasWritableValue ||
                               (evidence.valuePatternPresent && evidence.valueReadOnlyKnown && !evidence.valueReadOnly);
    const bool writableText = evidence.textPatternWritable ||
                              (evidence.textPatternPresent && evidence.textPatternReadOnlyKnown && !evidence.textPatternReadOnly);
    if (evidence.isTextEditControl || writableValue || writableText)
    {
        rejected.classification = KeyboardFocusClass::TextInput;
        if (evidence.isTextEditControl)
            rejected.reason = "text_edit_focus";
        else if (writableValue)
            rejected.reason = "writable_value_focus";
        else
            rejected.reason = "writable_text_pattern_focus";
        return rejected;
    }

    // P1-3 fail closed: an element obtained through ElementFromHandle may be the host container
    // of virtual subcontrols (the focused password field itself is not what was read), so the
    // container's non-text properties cannot authorize Safe.
    if (!evidence.focusIdentityConfirmed)
    {
        rejected.reason = "unconfirmed_focus_identity";
        return rejected;
    }

    // P1-3 fail closed: the pattern exists but its read-only property could not be read. The
    // surface may be a writable editor, so it is ambiguous, not display-only.
    if (evidence.valuePatternPresent && !evidence.valueReadOnlyKnown)
    {
        rejected.reason = "value_read_only_unknown";
        return rejected;
    }
    if (evidence.textPatternPresent && !evidence.textPatternReadOnlyKnown)
    {
        rejected.reason = "text_read_only_unknown";
        return rejected;
    }

    // Positively confirmed read-only surfaces stay accepted (the allowed demo page exposes a
    // read-only Document and existing read-only editors are display surfaces).
    const bool readOnlyValue =
        evidence.valuePatternPresent && evidence.valueReadOnlyKnown && evidence.valueReadOnly;
    const bool readOnlyText =
        evidence.textPatternPresent && evidence.textPatternReadOnlyKnown && evidence.textPatternReadOnly;
    if (readOnlyValue || readOnlyText)
    {
        KeyboardFocusDecision accepted;
        accepted.classification = KeyboardFocusClass::Safe;
        accepted.reason = "read_only_focus";
        return accepted;
    }

    // Positively confirmed non-text control: no ValuePattern/TextPattern at all and the control
    // type is not a Document/Text class.
    if (!evidence.isTextControlType && !evidence.valuePatternPresent && !evidence.textPatternPresent)
    {
        KeyboardFocusDecision accepted;
        accepted.classification = KeyboardFocusClass::Safe;
        accepted.reason = "safe_focus";
        return accepted;
    }

    // A Document/Text control whose read-only state could not be proven (e.g. a provider without
    // TextPattern) stays Unknown instead of being accepted by default.
    rejected.reason = "no_read_only_evidence";
    return rejected;
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
     * @note The bounded UIA probe can take up to the wall-clock budget after the key event.
     * Before an accept decision the classifier therefore re-reads the foreground window and the
     * native focus HWND (when the event-time snapshot had one); any change during the probe
     * yields Unknown/foreground_changed. The snapshot is otherwise read-only.
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
