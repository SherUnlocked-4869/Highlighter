/**
 * @file
 * @brief DEV-10 policy for the synthesized copy shortcut used by the clipboard fallback.
 *
 * A terminal resolves the synthesized Ctrl+C as SIGINT, so the clipboard fallback can
 * interrupt a running command instead of copying the selection. Standalone terminals are
 * rejected by the compiled program-name list in engine.cc. The remaining problem is a
 * process that hosts BOTH an editor surface and an integrated terminal (VS Code, Cursor,
 * and their close derivatives): the executable name is identical for both surfaces, so
 * the program name alone cannot protect the terminal.
 *
 * Evidence available at injection time (the fallback runs right after a gesture, so the
 * focus is expected to be the control the user selected text in):
 *  - Host process: executable basename of the retrieval window.
 *  - Win32 window class of the retrieval window (non-localized).
 *  - UIA focused element: control type, class name, localized control type, process id.
 *  - MSAA role of the focused object, when UIA cannot provide the focus owner.
 *  - Focus identity: the foreground window recorded when retrieval started is compared
 *    with the foreground window at injection time; the UIA focus owner's process id is
 *    compared with the retrieval window's process id.
 *
 * Classification rules (in order, first match wins):
 *  1. Program on the compiled terminal/self list                     -> skip.
 *  2. Terminal-like control, DOM, or window-class markers            -> skip.
 *  3. Foreground/focus identity changed since retrieval started      -> skip.
 *  4. Editor-host process: allow only when UIA reports a concrete
 *     Edit control in the target process; otherwise                -> skip (conservative).
 *  5. Anything else: keep the historical injection behavior          -> allow.
 *
 * Documented conservative policy for editor hosts: when the focused control cannot be
 * proven to be an editable text control, no synthetic key is injected. The editor loses
 * its clipboard fallback (UIA/MSAA selection reads still run and still work), but the
 * user's integrated-terminal task cannot be killed. This is an intentional trade-off;
 * re-evaluate it only with real-machine measurements of both surfaces.
 *
 * Residual uncertainty (deliberately documented instead of hidden):
 *  - Localized control type strings are matched in English. On other display languages
 *    terminal detection falls back to class names, the program list, and the conservative
 *    editor-host rule.
 *  - An editor host whose integrated terminal exposes a UIA Edit control (for example an
 *    xterm.js helper textarea) could be misread as an editable control. Terminal marker
 *    checks run first, but they cannot prove a negative; this remains the main residual
 *    misclassification risk and requires real-machine validation.
 *  - The window title is deliberately never used: it is localized user/document data and
 *    a document can be named like a terminal.
 *
 * This header is pure policy (no COM, clipboard, or input calls) so the Node bridge can
 * exercise exactly the production classifier from a headless test process.
 */
#pragma once

// UIAutomation.h assumes COM's interface macro has already been declared.
// clang-format off
#include <ole2.h>
#include <UIAutomation.h>
#include <windows.h>
// clang-format on

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

namespace highlighter
{

/** Machine-readable reasons recorded for every clipboard-copy injection decision. */
enum class ClipboardCopyGuardReason : std::size_t
{
    AllowDefault = 0,
    AllowEditorEditControl,
    SkipTerminalProgram,
    SkipTerminalTarget,
    SkipEditorHostAmbiguous,
    SkipFocusChanged,
    Count
};

constexpr std::size_t ClipboardCopyGuardReasonCount = static_cast<std::size_t>(ClipboardCopyGuardReason::Count);

/**
 * @brief Stable camelCase key for diagnostics objects, logs, and the native self-test.
 * @warning These strings are asserted by test/u04-selection-lock.test.js. Renaming them
 * changes the diagnostics contract.
 */
inline const char *ClipboardCopyGuardReasonKey(ClipboardCopyGuardReason reason)
{
    switch (reason)
    {
        case ClipboardCopyGuardReason::AllowDefault:
            return "allowDefault";
        case ClipboardCopyGuardReason::AllowEditorEditControl:
            return "allowEditorEditControl";
        case ClipboardCopyGuardReason::SkipTerminalProgram:
            return "skipTerminalProgram";
        case ClipboardCopyGuardReason::SkipTerminalTarget:
            return "skipTerminalTarget";
        case ClipboardCopyGuardReason::SkipEditorHostAmbiguous:
            return "skipEditorHostAmbiguous";
        case ClipboardCopyGuardReason::SkipFocusChanged:
            return "skipFocusChanged";
        case ClipboardCopyGuardReason::Count:
            break;
    }
    return "unknown";
}

enum class ClipboardCopyGuardVerdict
{
    Allow,
    Skip
};

/**
 * @brief Value-only evidence gathered immediately around the injection attempt.
 *
 * No COM pointer is stored: every probe is converted to plain data by the caller so this
 * type can cross a thread boundary, a log line, or the native self-test bridge.
 */
struct ClipboardCopyGuardEvidence
{
    std::wstring programName;                  ///< Executable basename of the retrieval window.
    bool programIsClipboardCopyProtected = false;  ///< Compiled terminal/self list matched.
    bool foregroundMatchesRetrievalStart = true;   ///< Foreground HWND unchanged since retrieval began.
    bool hasUiaFocus = false;                  ///< UIA focus owner + property probes succeeded.
    CONTROLTYPEID uiaControlType = 0;          ///< UIA control type id of the focus owner.
    std::wstring uiaClassName;                 ///< UIA ClassName property of the focus owner.
    std::wstring uiaLocalizedControlType;      ///< UIA LocalizedControlType property (localized).
    DWORD uiaProcessId = 0;                    ///< Owning process of the UIA focus owner.
    DWORD targetProcessId = 0;                 ///< Owning process of the retrieval window.
    std::wstring targetWindowClass;            ///< Win32 class name of the retrieval window.
    bool hasMsaaRole = false;                  ///< MSAA focus probe succeeded.
    long msaaRole = 0;                         ///< MSAA role of the focused object (diagnostic only).
};

struct ClipboardCopyGuardDecision
{
    ClipboardCopyGuardVerdict verdict = ClipboardCopyGuardVerdict::Allow;
    ClipboardCopyGuardReason reason = ClipboardCopyGuardReason::AllowDefault;
};

/** Process-wide counters consumed by the addon's diagnostics getter. */
struct ClipboardCopyGuardCounters
{
    ClipboardCopyGuardCounters()
    {
        for (std::size_t index = 0; index < ClipboardCopyGuardReasonCount; ++index)
        {
            counts[index].store(0, std::memory_order_relaxed);
            logged[index].store(false, std::memory_order_relaxed);
        }
    }

    std::atomic<uint64_t> counts[ClipboardCopyGuardReasonCount];
    std::atomic<bool> logged[ClipboardCopyGuardReasonCount];
};

inline ClipboardCopyGuardCounters &ClipboardCopyGuardCounterSingleton()
{
    static ClipboardCopyGuardCounters counters;
    return counters;
}

inline uint64_t ClipboardCopyGuardCount(ClipboardCopyGuardReason reason)
{
    const std::size_t index = static_cast<std::size_t>(reason);
    if (index >= ClipboardCopyGuardReasonCount)
        return 0;
    return ClipboardCopyGuardCounterSingleton().counts[index].load(std::memory_order_acquire);
}

inline std::wstring ClipboardCopyGuardLowerWide(const std::wstring &value)
{
    std::wstring lowered = value;
    std::transform(lowered.begin(), lowered.end(), lowered.begin(),
                   [](wchar_t character) { return static_cast<wchar_t>(towlower(character)); });
    return lowered;
}

inline std::wstring ClipboardCopyGuardTruncate(const std::wstring &value, std::size_t limit = 96)
{
    if (value.size() <= limit)
        return value;
    return value.substr(0, limit);
}

/**
 * @brief Record one decision: increment its counter and log the first skip per reason.
 * @param[in] decision Classifier output being applied.
 * @param[in] evidence Optional evidence attached to the one-time log line. Never stored.
 * @note Counters count evaluations, not retrievals. A retrieval that reaches the final
 * Ctrl+C re-check runs the classifier twice; the second evaluation is only recorded when
 * it skips, so allow counters approximate retrievals that passed the preflight check.
 */
inline void RecordClipboardCopyGuardDecision(const ClipboardCopyGuardDecision &decision,
                                             const ClipboardCopyGuardEvidence *evidence = nullptr)
{
    ClipboardCopyGuardCounters &counters = ClipboardCopyGuardCounterSingleton();
    const std::size_t index = static_cast<std::size_t>(decision.reason);
    if (index >= ClipboardCopyGuardReasonCount)
        return;
    counters.counts[index].fetch_add(1, std::memory_order_relaxed);
    if (decision.verdict == ClipboardCopyGuardVerdict::Allow)
        return;
    // A terminal-focused editor emits one skip per selection attempt; log only the first
    // occurrence per reason, with the evidence that produced it, to keep stderr bounded.
    if (counters.logged[index].exchange(true, std::memory_order_acq_rel))
        return;
    if (!evidence)
    {
        fprintf(stderr, "[selection-hook] clipboard copy injection skipped: reason=%s\n",
                ClipboardCopyGuardReasonKey(decision.reason));
        return;
    }
    const std::wstring program = ClipboardCopyGuardTruncate(evidence->programName, 64);
    const std::wstring windowClass = ClipboardCopyGuardTruncate(evidence->targetWindowClass, 64);
    const std::wstring elementClass = ClipboardCopyGuardTruncate(evidence->uiaClassName, 64);
    const std::wstring localizedType = ClipboardCopyGuardTruncate(evidence->uiaLocalizedControlType, 64);
    fprintf(stderr,
            "[selection-hook] clipboard copy injection skipped: reason=%s program=%ls windowClass=%ls "
            "uiaControlType=%ld uiaClass=%ls uiaLocalizedType=%ls msaaRole=%ld uiaPid=%lu targetPid=%lu "
            "foregroundStable=%d\n",
            ClipboardCopyGuardReasonKey(decision.reason), program.c_str(), windowClass.c_str(),
            static_cast<long>(evidence->uiaControlType), elementClass.c_str(), localizedType.c_str(),
            evidence->msaaRole, static_cast<unsigned long>(evidence->uiaProcessId),
            static_cast<unsigned long>(evidence->targetProcessId),
            evidence->foregroundMatchesRetrievalStart ? 1 : 0);
}

/**
 * @brief Class names / UIA names that identify a terminal surface.
 *
 * These markers are non-localized class-name fragments (and the English localized control
 * types used by some providers). They are a defense-in-depth layer for terminal hosts that
 * are missing from the compiled program list; the program list remains the primary guard.
 * @warning Keep this list bounded and specific: a false match only loses the clipboard
 * fallback for that application, but an over-broad marker would silently disable it widely.
 */
inline const std::vector<std::wstring> &ClipboardTerminalControlMarkers()
{
    static const std::vector<std::wstring> markers = {
        // Native terminal windows and terminal hosts.
        L"terminal", L"cascadia", L"console", L"conhost", L"mintty", L"wezterm",
        L"alacritty", L"kitty", L"xterm", L"terminus", L"conemu",
        // Chromium/Electron terminal DOM surfaces. An xterm.js integrated terminal can
        // expose its offscreen helper textarea with the UIA Edit control type; these
        // class/DOM markers deny that surface BEFORE the editor-host Edit exception can
        // classify it as editable, which is the main residual misclassification risk.
        L"helper-textarea", L"monaco-terminal"};
    return markers;
}

/**
 * @brief Programs that host an editor and an integrated terminal in one process.
 *
 * These are the VS Code family distributions. Other integrated-terminal hosts (for
 * example JetBrains IDEs) are intentionally not listed until real-machine measurements
 * exist; extending this list is a product decision, not a pure safety default.
 */
inline bool IsClipboardEditorHostProgram(const std::wstring &programName)
{
    if (programName.empty())
        return false;
    const std::wstring lowered = ClipboardCopyGuardLowerWide(programName);
    static const std::vector<std::wstring> programs = {
        L"code.exe", L"code - insiders.exe", L"cursor.exe", L"vscodium.exe", L"windsurf.exe"};
    for (const std::wstring &program : programs)
    {
        // Exact executable-basename comparison: substring matching would classify an
        // unrelated binary such as "encode.exe" as an editor host.
        if (lowered == program)
            return true;
    }
    return false;
}

inline bool ClipboardCopyGuardContainsMarker(const std::wstring &value,
                                             const std::vector<std::wstring> &markers)
{
    if (value.empty())
        return false;
    const std::wstring lowered = ClipboardCopyGuardLowerWide(value);
    for (const std::wstring &marker : markers)
    {
        if (lowered.find(marker) != std::wstring::npos)
            return true;
    }
    return false;
}

/** @return true when the retrieval window or its focused control looks like a terminal. */
inline bool ClipboardTargetLooksLikeTerminal(const ClipboardCopyGuardEvidence &evidence)
{
    if (ClipboardCopyGuardContainsMarker(evidence.targetWindowClass, ClipboardTerminalControlMarkers()))
        return true;
    if (ClipboardCopyGuardContainsMarker(evidence.uiaClassName, ClipboardTerminalControlMarkers()))
        return true;
    if (ClipboardCopyGuardContainsMarker(evidence.uiaLocalizedControlType, ClipboardTerminalControlMarkers()))
        return true;
    return false;
}

/**
 * @brief Decide whether the clipboard fallback may synthesize a copy shortcut.
 * @param[in] evidence Evidence gathered immediately before (and again right before) the
 *                     synthesized key. The policy itself performs no OS calls.
 * @return Allow only when no protective evidence exists; every uncertainty is a skip.
 * @warning The order matters. Terminal and focus checks run before the editor-host rule so
 * a proven terminal is never rescued by the editable-control exception.
 * @warning Do not add window-title checks here; see the file header for why.
 */
inline ClipboardCopyGuardDecision ClassifyClipboardCopyInjection(const ClipboardCopyGuardEvidence &evidence)
{
    // Defense in depth: the compiled terminal/self list normally rejects before the
    // fallback transaction starts, but a direct caller must not bypass it.
    if (evidence.programIsClipboardCopyProtected)
        return {ClipboardCopyGuardVerdict::Skip, ClipboardCopyGuardReason::SkipTerminalProgram};

    // Terminal evidence is evaluated before the focus-identity and editor-host rules.
    // In particular an xterm.js helper textarea that UIA reports as Edit must never be
    // rescued by the editor-host edit exception further down.
    if (ClipboardTargetLooksLikeTerminal(evidence))
        return {ClipboardCopyGuardVerdict::Skip, ClipboardCopyGuardReason::SkipTerminalTarget};

    // The shortcut is delivered to the current keyboard focus, while the selection text
    // was read from the retrieval window. If the foreground window changed in between,
    // the synthetic copy would land in an unrelated target.
    if (!evidence.foregroundMatchesRetrievalStart)
        return {ClipboardCopyGuardVerdict::Skip, ClipboardCopyGuardReason::SkipFocusChanged};

    // The UIA focus owner must belong to the retrieval window's process.
    if (evidence.hasUiaFocus && evidence.targetProcessId != 0 && evidence.uiaProcessId != 0 &&
        evidence.uiaProcessId != evidence.targetProcessId)
        return {ClipboardCopyGuardVerdict::Skip, ClipboardCopyGuardReason::SkipFocusChanged};

    if (IsClipboardEditorHostProgram(evidence.programName))
    {
        // Documented conservative policy: inside an editor host the process name cannot
        // separate the editor from its integrated terminal. Only a concrete UIA Edit
        // control in the same process is treated as unambiguously editable; everything
        // else keeps the native (no-injection) capture path instead of risking SIGINT.
        // Residual risk: a terminal surface whose UIA class/localized type does not match
        // any marker above but is still reported as Edit would be misclassified. The
        // marker list and the real-machine VS Code/Cursor matrix are the only mitigations;
        // this is why the editor-host exception is kept deliberately narrow.
        const bool concreteEditControl = evidence.hasUiaFocus &&
                                         evidence.uiaControlType == UIA_EditControlTypeId &&
                                         evidence.targetProcessId != 0 &&
                                         evidence.uiaProcessId == evidence.targetProcessId;
        if (concreteEditControl)
            return {ClipboardCopyGuardVerdict::Allow, ClipboardCopyGuardReason::AllowEditorEditControl};
        return {ClipboardCopyGuardVerdict::Skip, ClipboardCopyGuardReason::SkipEditorHostAmbiguous};
    }

    // No protective evidence: keep the historical clipboard fallback for this program.
    return {ClipboardCopyGuardVerdict::Allow, ClipboardCopyGuardReason::AllowDefault};
}

}  // namespace highlighter
