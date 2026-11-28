/**
 * @file
 * @brief DEV-04 bounded shortcut-combo policy for the WIN32 low-level keyboard hook.
 *
 * The recording HUD already captures shortcut combos while its own control bar has
 * keyboard focus (record/record.js keydown handler). When the user switches to the
 * application being recorded, that DOM path stops receiving keys, so the native
 * WH_KEYBOARD_LL hook has to provide the same information. The hook is process-wide and
 * privacy-sensitive, therefore this policy is deliberately stricter than a DOM keydown:
 *
 *  - Only modifier chords (Ctrl/Alt/Win, optionally Shift) and bare function keys are
 *    accepted. Plain typing, Shift+character capitals, IME composition keys, AltGr text
 *    input, OS auto-repeat, and injected/automation input are rejected before any object
 *    is allocated or any value crosses to JavaScript.
 *  - The emitted value is a key-identity label ("Ctrl+Shift+P", "F5"), never a typed
 *    character or any selected/edited content. Labels are produced from the virtual key
 *    code only; the character that a layout would generate is never computed.
 *  - The label grammar matches the persisted `keystrokes` track exactly (see
 *    main/services/recording-project-service.js): modifier tokens plus [A-Z0-9] or the
 *    named keys Space/Esc/Enter/Tab/Backspace/Delete/Insert/Home/End/PageUp/PageDown/
 *    Up/Down/Left/Right/F1..F12. Keys that cannot be represented (punctuation, media keys,
 *    F13+) are dropped; the control-bar DOM path applies the same limitation.
 *
 * This header is pure policy (no OS or input calls) so the Node bridge can exercise the
 * exact production classifier from a headless test process.
 */
#pragma once

#include <windows.h>

#include <cstddef>
#include <string>

namespace highlighter
{

// Event-time modifier bits emitted to JavaScript. Bits 0-2 intentionally match the
// MouseEventContext modifier mask already used by the selection hook mouse events; bit 3
// is the Windows key, which only the keyboard channel reports.
constexpr unsigned long KeyboardComboShift = 1ul << 0;
constexpr unsigned long KeyboardComboControl = 1ul << 1;
constexpr unsigned long KeyboardComboAlt = 1ul << 2;
constexpr unsigned long KeyboardComboWin = 1ul << 3;

enum class KeyboardComboVerdict
{
    Accepted,
    Rejected
};

/** Value-only event-time evidence; constructed on the hook thread, never stores handles. */
struct KeyboardComboEvidence
{
    unsigned long vkCode = 0;      ///< Main key virtual code.
    unsigned long scanCode = 0;    ///< Hardware scan code (informational).
    unsigned long modifiers = 0;   ///< Event-time modifier bitmask (KeyboardCombo* bits).
    bool injected = false;         ///< LLKHF_INJECTED: synthesized input, never a user shortcut.
    bool autoRepeat = false;       ///< Repeat of the same held key, not a new press.
    bool altGraph = false;         ///< Best-effort AltGr text-input detection.
};

struct KeyboardComboDecision
{
    KeyboardComboVerdict verdict = KeyboardComboVerdict::Rejected;
    std::string label;             ///< Allowlisted combo label; empty when rejected.
    const char *reason = "rejected";  // Stable ASCII reason for tests and diagnostics.
};

/** @return true when the code is a pure modifier key that can never be a combo main key. */
inline bool IsKeyboardModifierVirtualKey(unsigned long vkCode)
{
    switch (vkCode)
    {
        case VK_SHIFT:
        case VK_LSHIFT:
        case VK_RSHIFT:
        case VK_CONTROL:
        case VK_LCONTROL:
        case VK_RCONTROL:
        case VK_MENU:
        case VK_LMENU:
        case VK_RMENU:
        case VK_LWIN:
        case VK_RWIN:
            return true;
        default:
            return false;
    }
}

/** @return true for F1..F12, the only bare keys this channel may emit. */
inline bool IsKeyboardFunctionVirtualKey(unsigned long vkCode)
{
    return vkCode >= VK_F1 && vkCode <= VK_F12;
}

/**
 * @brief Map a virtual key code to the allowlisted key label.
 * @param[in] vkCode Virtual key code.
 * @param[out] label Key label from the persisted keystrokes grammar.
 * @return false when the key cannot be represented by that grammar.
 * @note Letters are upper case key identities, not typed characters. No keyboard layout
 * state (shift/caps) and no character composition is consulted.
 */
inline bool KeyboardComboKeyLabel(unsigned long vkCode, std::string &label)
{
    if (vkCode >= 'A' && vkCode <= 'Z')
    {
        label.assign(1, static_cast<char>(vkCode));
        return true;
    }
    if (vkCode >= '0' && vkCode <= '9')
    {
        label.assign(1, static_cast<char>(vkCode));
        return true;
    }
    if (vkCode >= VK_F1 && vkCode <= VK_F12)
    {
        label.assign("F");
        label += std::to_string(static_cast<int>(vkCode - VK_F1 + 1));
        return true;
    }
    switch (vkCode)
    {
        case VK_SPACE:
            label = "Space";
            return true;
        case VK_ESCAPE:
            label = "Esc";
            return true;
        case VK_RETURN:
            label = "Enter";
            return true;
        case VK_TAB:
            label = "Tab";
            return true;
        case VK_BACK:
            label = "Backspace";
            return true;
        case VK_DELETE:
            label = "Delete";
            return true;
        case VK_INSERT:
            label = "Insert";
            return true;
        case VK_HOME:
            label = "Home";
            return true;
        case VK_END:
            label = "End";
            return true;
        case VK_PRIOR:
            label = "PageUp";
            return true;
        case VK_NEXT:
            label = "PageDown";
            return true;
        case VK_UP:
            label = "Up";
            return true;
        case VK_DOWN:
            label = "Down";
            return true;
        case VK_LEFT:
            label = "Left";
            return true;
        case VK_RIGHT:
            label = "Right";
            return true;
        default:
            return false;
    }
}

/**
 * @brief Classify one key-down event for the opt-in keyboard combo channel.
 * @param[in] evidence Event-time evidence captured in the hook callback.
 * @return Accepted with a grammar-valid label, or Rejected with a stable reason.
 * @warning The privacy rule is enforced here, before any JavaScript object exists.
 * Changing the accept set changes what the recording HUD can display and reopens the
 * "plain typing must never leave the process" guarantee; re-run the combo policy tests.
 */
inline KeyboardComboDecision ClassifyKeyboardCombo(const KeyboardComboEvidence &evidence)
{
    KeyboardComboDecision rejected;
    rejected.verdict = KeyboardComboVerdict::Rejected;

    // Synthesized input includes our own clipboard-fallback Ctrl+C; it is not a user
    // shortcut and must never be reported as one.
    if (evidence.injected)
    {
        rejected.reason = "injected_input";
        return rejected;
    }
    if (evidence.autoRepeat)
    {
        rejected.reason = "auto_repeat";
        return rejected;
    }
    // AltGr text input arrives as synthetic Ctrl+Alt on many layouts. Reporting it would
    // show a false shortcut in the HUD for a typed character.
    if (evidence.altGraph)
    {
        rejected.reason = "altgraph_text_input";
        return rejected;
    }
    if (evidence.vkCode == VK_PROCESSKEY || evidence.vkCode == 0)
    {
        rejected.reason = "ime_process_key";
        return rejected;
    }
    if (IsKeyboardModifierVirtualKey(evidence.vkCode))
    {
        rejected.reason = "modifier_key";
        return rejected;
    }

    std::string keyLabel;
    if (!KeyboardComboKeyLabel(evidence.vkCode, keyLabel))
    {
        rejected.reason = "key_not_allowlisted";
        return rejected;
    }

    const bool letterOrDigit =
        (evidence.vkCode >= 'A' && evidence.vkCode <= 'Z') || (evidence.vkCode >= '0' && evidence.vkCode <= '9');
    const bool functionKey = IsKeyboardFunctionVirtualKey(evidence.vkCode);
    const bool commandModifier =
        (evidence.modifiers & (KeyboardComboControl | KeyboardComboAlt | KeyboardComboWin)) != 0;

    // Shift+letter/digit is a capital character, i.e. plain typing. A command modifier is
    // required so this channel can never echo typed text, even as a key label.
    if (letterOrDigit && !commandModifier)
    {
        rejected.reason = "plain_text_input";
        return rejected;
    }
    // Bare named keys would report navigation/editing input; keep bare keys to F1..F12
    // only (matches the HUD copy "modifier chords and function keys only").
    if (!letterOrDigit && !functionKey && evidence.modifiers == 0)
    {
        rejected.reason = "bare_named_key";
        return rejected;
    }

    // Modifier order matches record/record.js so the same chord produces the same label
    // from the control-bar DOM path and from this native channel.
    std::string label;
    if (evidence.modifiers & KeyboardComboControl)
        label += "Ctrl+";
    if (evidence.modifiers & KeyboardComboAlt)
        label += "Alt+";
    if (evidence.modifiers & KeyboardComboShift)
        label += "Shift+";
    if (evidence.modifiers & KeyboardComboWin)
        label += "Win+";
    label += keyLabel;
    if (label.size() > 48)
    {
        rejected.reason = "label_too_long";
        return rejected;
    }

    KeyboardComboDecision accepted;
    accepted.verdict = KeyboardComboVerdict::Accepted;
    accepted.label = label;
    accepted.reason = "accepted";
    return accepted;
}

}  // namespace highlighter
