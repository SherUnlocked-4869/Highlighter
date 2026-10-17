#include "../../../vendor/selection-hook/src/windows/lib/clipboard_policy.h"
#include "../../../vendor/selection-hook/src/windows/lib/transient.h"
#include <cstdio>
#include <cstdlib>
#include <cstdint>
using highlighter::RestorePolicy;
static void require(bool value, const char *name) { if (!value) { std::fprintf(stderr,"Failed: %s\n",name); std::exit(1); } }

int main() {
    for (unsigned round=0; round<100; ++round) {
        RestorePolicy normal(10,1,200,100);
        require(normal.mayClear(10,1),"unchanged before clear");
        require(!normal.mayClear(11,1),"copy before clear");
        require(!normal.mayClear(10,2),"input before clear");
        normal.cleared(11); normal.observePublication(12);
        require(normal.read({12,200,1},true),"target publication");
        require(normal.mayRestore({12,200,1}),"normal restore");
        // A preliminary check succeeds, but the comparison made under the lock
        // must reject a real copy arriving just before OpenClipboard succeeds.
        require(!normal.mayRestore({13,200,2}),"same-app Ctrl+C after preliminary check");
        require(!normal.mayRestore({12,200,2}),"fast key down/up between polls");
        require(!normal.mayRestore({13,300,1}),"asynchronous foreign copy");
        require(!normal.mayRestore({13,200,1}),"same-app late write after read");
        require(!normal.mayRestore({12,0,1}),"unknown owner");

        RestorePolicy empty(1,1,200,100);
        empty.cleared(2);
        require(empty.mayRestore({2,100,1}),"failed copy restores empty or nonempty original");
        require(empty.mayRestore({2,100,2}),"input interruption while only our clear exists");
        require(!empty.mayRestore({3,200,2}),"real copy wins over our empty clipboard");

        RestorePolicy delayed(1,1,200,100);
        delayed.cleared(2); delayed.observePublication(3);
        require(!delayed.read({4,200,1},true),"ambiguous multi-publication");
        require(!delayed.mayRestore({4,200,1}),"ambiguous payload is not overwritten");

        RestorePolicy wrapped(UINT32_MAX,1,200,100);
        wrapped.cleared(0); wrapped.observePublication(1);
        require(wrapped.read({1,200,1},true),"sequence wrap");
        require(wrapped.mayRestore({1,200,1}),"restore after wrap");
        require(!wrapped.mayRestore({2,200,1}),"no interval suppression");
    }
    const uint64_t input = highlighter::InputSerial();
    KBDLLHOOKSTRUCT event{};
    event.vkCode = 'C';
    highlighter::ObserveInput(event, WM_KEYDOWN);
    highlighter::ObserveInput(event, WM_KEYUP);
    require(highlighter::InputSerial() == input+1, "rapid physical key remains observable");
    event.flags = LLKHF_INJECTED; event.dwExtraInfo = highlighter::InputTag();
    highlighter::ObserveInput(event, WM_KEYDOWN);
    require(highlighter::InputSerial() == input+1, "only our own injection is ignored");
    event.dwExtraInfo += 1;
    highlighter::ObserveInput(event, WM_KEYDOWN);
    require(highlighter::InputSerial() == input+2, "foreign tool injection interrupts");

    highlighter::CoordinatorConfig config;
    highlighter::TransientLease uncoordinated(config, false);
    require(uncoordinated.valid(), "disabled feature needs no sidecar");
    config.revision->fetch_add(1);
    require(!uncoordinated.valid(), "configuration invalidates in-flight old snapshots");
    config.required = true; config.expectedRevision = config.revision->load();
    highlighter::TransientLease synchronous(config, false);
    require(!synchronous.valid(), "calling thread never waits for a lease");
    std::puts("Clipboard restore policy: 100 interleaving rounds and native input checks passed");
}
