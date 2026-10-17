#pragma once
#include <cstdint>

namespace highlighter {
struct ClipboardStamp { uint32_t sequence, ownerPid; uint64_t input; };

// Equality, never sequence intervals: Windows sequences wrap and skip values.
class RestorePolicy {
  public:
    RestorePolicy(uint32_t sequence, uint64_t input, uint32_t target, uint32_t self)
        : initialSequence_(sequence), input_(input), target_(target), self_(self) {}
    bool mayClear(uint32_t sequence, uint64_t input) const { return sequence == initialSequence_ && input == input_; }
    void cleared(uint32_t sequence) { expected_ = {sequence, self_, input_}; cleared_ = true; }
    void observePublication(uint32_t sequence) { if (!observed_) { firstPublication_ = sequence; observed_ = true; } }
    bool read(ClipboardStamp stamp, bool strict) {
        if (!cleared_ || stamp.input != input_ || stamp.ownerPid == 0 || stamp.ownerPid != target_
            || stamp.sequence == expected_.sequence || (strict && observed_ && firstPublication_ != stamp.sequence)) {
            ambiguous_ = true; return false;
        }
        expected_ = stamp;
        return true;
    }
    void ambiguous() { ambiguous_ = true; }
    bool mayRestore(ClipboardStamp current) const {
        return cleared_ && !ambiguous_ && (current.input == input_ || expected_.ownerPid == self_) && current.sequence == expected_.sequence
            && current.ownerPid != 0 && current.ownerPid == expected_.ownerPid;
    }
  private:
    uint32_t initialSequence_, target_, self_, firstPublication_ = 0;
    uint64_t input_;
    ClipboardStamp expected_{};
    bool cleared_ = false, ambiguous_ = false, observed_ = false;
};
}
