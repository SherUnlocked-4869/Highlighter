/**
 * @file
 * @brief DEV-04 bounded focus-evidence collection for the native shortcut-combo channel.
 *
 * Threading contract: CaptureKeyboardFocusSnapshot() runs inside the WH_KEYBOARD_LL callback
 * and only performs the cheap Win32 snapshot (GetForegroundWindow / GetWindowThreadProcessId /
 * GetGUIThreadInfo). It never touches UIA/MSAA and never dispatches messages, so a hung
 * application cannot extend the hook callback past the LowLevelHooksTimeout budget.
 *
 * KeyboardFocusClassifier runs on the JavaScript thread (TSFN callback) and owns one
 * IUIAutomation2 client created on that same thread. IUIAutomation2's connection/transaction
 * timeouts bound every provider call; an additional wall-clock budget rejects the event when
 * even the bounded calls together take too long. Any failure, timeout or ambiguity yields
 * KeyboardFocusClass::Unknown, i.e. the combo is dropped (fail closed).
 *
 * After the UIA probe, ClassifyForeground re-checks the cheap foreground/focus identity: the
 * probe can run up to the wall-clock budget after the key event, so a focus change during it
 * must never be classified as the surface the shortcut was pressed on (TOCTOU guard).
 *
 * The policy itself lives in keyboard_focus.h and is pure; this file only gathers evidence.
 */
#define WIN32_LEAN_AND_MEAN 1

#include "keyboard_focus.h"

// clang-format off
#include <windows.h>
#include <ole2.h>
#include <UIAutomation.h>
#include <imm.h>
// clang-format on

namespace highlighter
{
namespace
{
// A hung accessibility provider must not stall the JavaScript thread. Both IUIAutomation2
// timeouts are per cross-process call; the budget below additionally caps the whole probe
// (several property reads) so a slow-but-alive provider still fails closed quickly.
constexpr DWORD kFocusConnectionTimeoutMs = 250;
constexpr DWORD kFocusTransactionTimeoutMs = 250;
constexpr ULONGLONG kFocusProbeBudgetMs = 500;

/** @return true once the whole classification probe exceeded its wall-clock budget. */
bool ProbeBudgetExceeded(ULONGLONG startedAt)
{
    return GetTickCount64() - startedAt > kFocusProbeBudgetMs;
}

/**
 * @brief Best-effort IME composition check for a focus window.
 * @param[in] focusWindow Focus owner window handle from the event-time snapshot.
 * @return true when an IME composition string is active for that window.
 * @note IMM input contexts are thread-scoped: for a window owned by another process Windows
 * returns no context here, so a composition running in another application cannot be read this
 * way. In practice composition happens inside an editable text element, which the UIA text rule
 * classifies as TextInput and drops, and the key policy already rejects VK_PROCESSKEY. The pure
 * policy still supports the ime class and the native self-test asserts it.
 */
bool ProbeImeComposition(HWND focusWindow)
{
    if (!focusWindow || !IsWindow(focusWindow))
        return false;
    HIMC context = ImmGetContext(focusWindow);
    if (!context)
        return false;
    const LONG compositionBytes = ImmGetCompositionStringW(context, GCS_COMPSTR, nullptr, 0);
    const LONG readBytes = ImmGetCompositionStringW(context, GCS_COMPREADSTR, nullptr, 0);
    ImmReleaseContext(focusWindow, context);
    return compositionBytes > 0 || readBytes > 0;
}

/**
 * @brief Cheap TOCTOU re-check after the bounded UIA probe.
 * @param[in] snapshot Event-time foreground/focus handles captured in the hook.
 * @return true when the foreground window (and, if one was recorded, the native focus HWND of
 * its thread) is still the one from the key event.
 * @note The UIA probe can take up to the wall-clock budget, so accepting a surface that became
 * focused during the probe would attribute the shortcut to the wrong context. A web-content
 * focus change inside the same window does not move hwndFocus and stays a documented residual.
 */
bool FocusSnapshotStillCurrent(const KeyboardFocusSnapshot &snapshot)
{
    if (GetForegroundWindow() != snapshot.foregroundWindow)
        return false;
    if (!snapshot.focusWindow)
        return true;
    const DWORD foregroundThread = GetWindowThreadProcessId(snapshot.foregroundWindow, nullptr);
    if (!foregroundThread)
        return false;
    GUITHREADINFO threadInfo;
    ZeroMemory(&threadInfo, sizeof(threadInfo));
    threadInfo.cbSize = sizeof(GUITHREADINFO);
    if (!GetGUIThreadInfo(foregroundThread, &threadInfo))
        return false;
    return threadInfo.hwndFocus == snapshot.focusWindow;
}

/** Value-only evidence read from one UIA element; never stores COM pointers. */
struct ElementEvidence
{
    bool available = false;
    bool isPassword = false;
    bool isTextEditControl = false;
    bool hasWritableValue = false;
    bool textPatternReadOnly = false;
    bool textPatternWritable = false;
    bool timedOut = false;
};

/**
 * @brief Read the focus-classification properties of a UIA element.
 * @param[in] element Borrowed element; the caller owns the reference.
 * @param[in] startedAt Probe start tick used by the wall-clock budget.
 * @return Value-only evidence; timedOut=true when a property read exceeded the budget.
 */
ElementEvidence ReadElementEvidence(IUIAutomationElement *element, ULONGLONG startedAt)
{
    ElementEvidence result;

    // The control type and the password flag are the two properties the accept/reject decision
    // depends on. A provider that cannot answer them is ambiguous, so the whole evidence stays
    // unavailable and the policy fails closed instead of assuming a safe surface.
    CONTROLTYPEID controlType = 0;
    if (FAILED(element->get_CurrentControlType(&controlType)))
    {
        result.timedOut = ProbeBudgetExceeded(startedAt);
        return result;
    }
    result.available = true;
    result.isTextEditControl = controlType == UIA_EditControlTypeId;
    if (ProbeBudgetExceeded(startedAt))
    {
        result.timedOut = true;
        return result;
    }

    BOOL isPassword = FALSE;
    if (FAILED(element->get_CurrentIsPassword(&isPassword)))
    {
        result.available = false;
        result.timedOut = ProbeBudgetExceeded(startedAt);
        return result;
    }
    result.isPassword = isPassword != FALSE;
    if (ProbeBudgetExceeded(startedAt))
    {
        result.timedOut = true;
        return result;
    }

    // A writable ValuePattern means text can be typed into the focus owner even when its control
    // type is not Edit (combo box, spinner, custom text control). Read-only values are display
    // surfaces and stay safe.
    IUIAutomationValuePattern *valuePattern = nullptr;
    if (SUCCEEDED(element->GetCurrentPatternAs(UIA_ValuePatternId, __uuidof(IUIAutomationValuePattern),
                                              reinterpret_cast<void **>(&valuePattern))) &&
        valuePattern)
    {
        BOOL readOnly = TRUE;
        if (SUCCEEDED(valuePattern->get_CurrentIsReadOnly(&readOnly)))
            result.hasWritableValue = readOnly == FALSE;
        valuePattern->Release();
    }
    if (ProbeBudgetExceeded(startedAt))
    {
        result.timedOut = true;
        return result;
    }

    // A writable UIA TextPattern identifies a text-editing surface whose control type is not
    // Edit: Word documents, RichEdit/Scintilla-style editors and custom text controls. The
    // browser-page demo scenario also exposes a TextPattern, but its document range reports
    // UIA_IsReadOnlyAttributeId = TRUE, so it stays Safe.
    //
    // NOTE: this is deliberately NOT the broad DocumentRange fallback removed for issue #25;
    // that path passed an element *property* id (30034) as a text attribute. Here the real text
    // attribute UIA_IsReadOnlyAttributeId is queried once per shortcut press, with the
    // IUIAutomation2 connection/transaction timeouts and the wall-clock budget bounding the
    // client. A provider that does not answer the attribute keeps the weaker
    // control-type/ValuePattern rule (documented residual in keyboard_focus.h).
    //
    // Already-sensitive evidence skips this more expensive probe: the decision is a rejection
    // either way.
    if (!result.isPassword && !result.isTextEditControl && !result.hasWritableValue)
    {
        IUIAutomationTextPattern *textPattern = nullptr;
        if (SUCCEEDED(element->GetCurrentPatternAs(UIA_TextPatternId, __uuidof(IUIAutomationTextPattern),
                                                  reinterpret_cast<void **>(&textPattern))) &&
            textPattern)
        {
            if (ProbeBudgetExceeded(startedAt))
            {
                result.timedOut = true;
                textPattern->Release();
                return result;
            }
            IUIAutomationTextRange *documentRange = nullptr;
            const HRESULT rangeResult = textPattern->get_DocumentRange(&documentRange);
            textPattern->Release();
            if (ProbeBudgetExceeded(startedAt))
            {
                result.timedOut = true;
                if (documentRange)
                    documentRange->Release();
                return result;
            }
            if (SUCCEEDED(rangeResult) && documentRange)
            {
                VARIANT isReadOnly;
                VariantInit(&isReadOnly);
                const HRESULT attributeResult =
                    documentRange->GetAttributeValue(UIA_IsReadOnlyAttributeId, &isReadOnly);
                documentRange->Release();
                if (ProbeBudgetExceeded(startedAt))
                    result.timedOut = true;
                // Attribute unavailable (provider does not expose it) is not text; only a
                // present TRUE/FALSE value drives the read-only/writable evidence.
                if (SUCCEEDED(attributeResult) && isReadOnly.vt == VT_BOOL)
                {
                    result.textPatternReadOnly = isReadOnly.boolVal != VARIANT_FALSE;
                    result.textPatternWritable = isReadOnly.boolVal == VARIANT_FALSE;
                }
                VariantClear(&isReadOnly);
            }
        }
    }
    if (ProbeBudgetExceeded(startedAt))
        result.timedOut = true;
    return result;
}

/**
 * @brief Probe the currently focused UIA element for one event-time snapshot.
 * @param[in] automation Bounded UIA client owned by the calling thread.
 * @param[in] snapshot Event-time focus snapshot.
 * @param[in] startedAt Probe start tick used by the wall-clock budget.
 * @return Value-only evidence; available=false when no trustworthy element was obtained.
 */
ElementEvidence ProbeFocusedElement(IUIAutomation *automation, const KeyboardFocusSnapshot &snapshot,
                                    ULONGLONG startedAt)
{
    ElementEvidence result;
    IUIAutomationElement *element = nullptr;
    HRESULT hr = automation->GetFocusedElement(&element);
    if (ProbeBudgetExceeded(startedAt))
    {
        result.timedOut = true;
        if (element)
            element->Release();
        return result;
    }

    bool usable = false;
    if (SUCCEEDED(hr) && element)
    {
        int elementProcessId = 0;
        if (SUCCEEDED(element->get_CurrentProcessId(&elementProcessId)) && elementProcessId > 0 &&
            static_cast<DWORD>(elementProcessId) == snapshot.processId)
        {
            // The focused element must still belong to the event-time foreground window: a stale
            // drain must not classify a surface the user switched to after the key press. Web
            // content elements commonly report no native window handle, so accept those on the
            // process evidence alone; a handle must resolve to the same top-level foreground.
            bool sameWindow = true;
            UIA_HWND nativeWindow = 0;
            if (SUCCEEDED(element->get_CurrentNativeWindowHandle(&nativeWindow)) && nativeWindow)
            {
                const HWND elementWindow = reinterpret_cast<HWND>(nativeWindow);
                sameWindow = elementWindow == snapshot.focusWindow ||
                             GetAncestor(elementWindow, GA_ROOT) == snapshot.foregroundWindow;
            }
            usable = sameWindow;
        }
        if (!usable)
        {
            element->Release();
            element = nullptr;
        }
    }

    // Fallback to the event-time focus HWND itself. ElementFromHandle maps a child control HWND
    // to its own element and keeps the classification usable for providers that do not expose a
    // global focused element.
    if (!element && snapshot.focusWindow && IsWindow(snapshot.focusWindow))
    {
        hr = automation->ElementFromHandle(snapshot.focusWindow, &element);
        if (ProbeBudgetExceeded(startedAt))
        {
            result.timedOut = true;
            if (element)
                element->Release();
            return result;
        }
        if (SUCCEEDED(hr) && element)
        {
            int elementProcessId = 0;
            if (!SUCCEEDED(element->get_CurrentProcessId(&elementProcessId)) || elementProcessId <= 0 ||
                static_cast<DWORD>(elementProcessId) != snapshot.processId)
            {
                element->Release();
                element = nullptr;
            }
        }
    }

    if (!element)
        return result;
    result = ReadElementEvidence(element, startedAt);
    element->Release();
    return result;
}

/**
 * @brief Probe one explicit window/control handle (deterministic self-test/probe path).
 * @param[in] automation Bounded UIA client owned by the calling thread.
 * @param[in] window Window or child control handle to classify.
 * @param[in] expectedProcessId Process that owns the handle.
 * @param[in] startedAt Probe start tick used by the wall-clock budget.
 * @return Value-only evidence; available=false when no trustworthy element was obtained.
 */
ElementEvidence ProbeWindowHandle(IUIAutomation *automation, HWND window, DWORD expectedProcessId,
                                  ULONGLONG startedAt)
{
    ElementEvidence result;
    IUIAutomationElement *element = nullptr;
    const HRESULT hr = automation->ElementFromHandle(window, &element);
    if (ProbeBudgetExceeded(startedAt))
    {
        result.timedOut = true;
        if (element)
            element->Release();
        return result;
    }
    if (FAILED(hr) || !element)
        return result;

    int elementProcessId = 0;
    if (!SUCCEEDED(element->get_CurrentProcessId(&elementProcessId)) || elementProcessId <= 0 ||
        static_cast<DWORD>(elementProcessId) != expectedProcessId)
    {
        element->Release();
        return result;
    }
    result = ReadElementEvidence(element, startedAt);
    element->Release();
    return result;
}
}  // namespace

KeyboardFocusSnapshot CaptureKeyboardFocusSnapshot()
{
    KeyboardFocusSnapshot snapshot;
    snapshot.foregroundWindow = GetForegroundWindow();
    if (!snapshot.foregroundWindow)
        return snapshot;

    const DWORD foregroundThread = GetWindowThreadProcessId(snapshot.foregroundWindow, &snapshot.processId);
    GUITHREADINFO threadInfo;
    ZeroMemory(&threadInfo, sizeof(threadInfo));
    threadInfo.cbSize = sizeof(GUITHREADINFO);
    if (foregroundThread && GetGUIThreadInfo(foregroundThread, &threadInfo))
        snapshot.focusWindow = threadInfo.hwndFocus;
    snapshot.valid = snapshot.processId != 0;
    return snapshot;
}

struct KeyboardFocusClassifier::Impl
{
    // Created, used and released on the thread that calls the classifier (the JavaScript thread
    // for the production path). Never touched from the hook thread.
    IUIAutomation *automation = nullptr;
    // Sticky failure: without IUIAutomation2 the client cannot prove the timeout bound, so every
    // combo stays rejected for the lifetime of this classifier instead of retrying forever.
    bool failed = false;

    void Reset()
    {
        if (automation)
        {
            automation->Release();
            automation = nullptr;
        }
    }

    /** @return the bounded UIA client, or null when one cannot be created safely. */
    IUIAutomation *Ensure()
    {
        if (automation)
            return automation;
        if (failed)
            return nullptr;

        // CUIAutomation8 provides IUIAutomation2. A plain CUIAutomation client (used elsewhere in
        // this addon for selection retrieval) has no timeout properties, so it cannot be used for
        // a per-key classification that must never block on a hung provider.
        IUIAutomation *base = nullptr;
        HRESULT hr = CoCreateInstance(__uuidof(CUIAutomation8), nullptr, CLSCTX_INPROC_SERVER,
                                      __uuidof(IUIAutomation), reinterpret_cast<void **>(&base));
        if (FAILED(hr) || !base)
        {
            failed = true;
            return nullptr;
        }
        IUIAutomation2 *bounded = nullptr;
        hr = base->QueryInterface(__uuidof(IUIAutomation2), reinterpret_cast<void **>(&bounded));
        base->Release();
        if (FAILED(hr) || !bounded)
        {
            failed = true;
            return nullptr;
        }
        if (FAILED(bounded->put_ConnectionTimeout(kFocusConnectionTimeoutMs)) ||
            FAILED(bounded->put_TransactionTimeout(kFocusTransactionTimeoutMs)))
        {
            bounded->Release();
            failed = true;
            return nullptr;
        }
        automation = bounded;  // IUIAutomation2 derives from IUIAutomation
        return automation;
    }
};

KeyboardFocusClassifier::KeyboardFocusClassifier() : impl_(new Impl()) {}

KeyboardFocusClassifier::~KeyboardFocusClassifier()
{
    Reset();
}

void KeyboardFocusClassifier::Reset()
{
    if (impl_)
        impl_->Reset();
}

bool KeyboardFocusClassifier::IsAvailable()
{
    return impl_->Ensure() != nullptr;
}

KeyboardFocusDecision KeyboardFocusClassifier::ClassifyForeground(const KeyboardFocusSnapshot &snapshot)
{
    KeyboardFocusEvidence evidence;
    evidence.foregroundAlive =
        snapshot.valid && snapshot.foregroundWindow != nullptr && IsWindow(snapshot.foregroundWindow) != FALSE;
    evidence.foregroundIsCurrent = evidence.foregroundAlive && GetForegroundWindow() == snapshot.foregroundWindow;
    evidence.ownProcess = snapshot.processId != 0 && snapshot.processId == GetCurrentProcessId();
    // Cheap rejections are decided without touching UIA at all.
    if (!evidence.foregroundAlive || !evidence.foregroundIsCurrent || evidence.ownProcess)
        return ClassifyKeyboardFocus(evidence);

    const ULONGLONG startedAt = GetTickCount64();
    IUIAutomation *automation = impl_->Ensure();
    if (!automation)
    {
        evidence.classifierAvailable = false;
        return ClassifyKeyboardFocus(evidence);
    }

    evidence.imeComposing = ProbeImeComposition(snapshot.focusWindow);
    if (evidence.imeComposing)
        return ClassifyKeyboardFocus(evidence);

    const ElementEvidence element = ProbeFocusedElement(automation, snapshot, startedAt);

    // TOCTOU guard: the probe can run up to the wall-clock budget after the key event, so the
    // element it inspected may belong to a surface the user focused after the press. Re-read the
    // cheap focus identity and fail closed on any change; the probe evidence is discarded because
    // it may describe a different surface.
    if (!FocusSnapshotStillCurrent(snapshot))
    {
        evidence.foregroundIsCurrent = false;
        return ClassifyKeyboardFocus(evidence);
    }

    evidence.probeTimedOut = element.timedOut;
    evidence.elementAvailable = element.available;
    evidence.isPassword = element.isPassword;
    evidence.isTextEditControl = element.isTextEditControl;
    evidence.hasWritableValue = element.hasWritableValue;
    evidence.textPatternReadOnly = element.textPatternReadOnly;
    evidence.textPatternWritable = element.textPatternWritable;
    return ClassifyKeyboardFocus(evidence);
}

KeyboardFocusDecision KeyboardFocusClassifier::ClassifyWindowHandle(HWND window)
{
    KeyboardFocusEvidence evidence;
    evidence.foregroundAlive = window != nullptr && IsWindow(window) != FALSE;
    // The caller supplies the exact target handle, so "still foreground" is not required; this
    // path exists for the deterministic probe and for self-tests of the classification engine.
    evidence.foregroundIsCurrent = true;
    DWORD windowProcessId = 0;
    if (evidence.foregroundAlive)
        GetWindowThreadProcessId(window, &windowProcessId);
    evidence.ownProcess = windowProcessId != 0 && windowProcessId == GetCurrentProcessId();
    if (!evidence.foregroundAlive || evidence.ownProcess)
        return ClassifyKeyboardFocus(evidence);

    const ULONGLONG startedAt = GetTickCount64();
    IUIAutomation *automation = impl_->Ensure();
    if (!automation)
    {
        evidence.classifierAvailable = false;
        return ClassifyKeyboardFocus(evidence);
    }

    evidence.imeComposing = ProbeImeComposition(window);
    if (evidence.imeComposing)
        return ClassifyKeyboardFocus(evidence);

    const ElementEvidence element = ProbeWindowHandle(automation, window, windowProcessId, startedAt);
    evidence.probeTimedOut = element.timedOut;
    evidence.elementAvailable = element.available;
    evidence.isPassword = element.isPassword;
    evidence.isTextEditControl = element.isTextEditControl;
    evidence.hasWritableValue = element.hasWritableValue;
    evidence.textPatternReadOnly = element.textPatternReadOnly;
    evidence.textPatternWritable = element.textPatternWritable;
    return ClassifyKeyboardFocus(evidence);
}

}  // namespace highlighter

