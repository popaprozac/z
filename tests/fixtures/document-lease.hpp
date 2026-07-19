#pragma once

#include <stdint.h>
#include <utility>

namespace desktop {

inline int32_t live_document_leases = 0;
inline int32_t moved_document_leases = 0;

class DocumentLease {
public:
  explicit DocumentLease(int32_t document_id)
      : document_id_(document_id), save_count_(0), active_(true) {
    live_document_leases += 1;
  }

  DocumentLease(const DocumentLease &) = delete;
  DocumentLease &operator=(const DocumentLease &) = delete;

  DocumentLease(DocumentLease &&other) noexcept
      : document_id_(other.document_id_),
        save_count_(other.save_count_),
        active_(other.active_) {
    other.active_ = false;
    moved_document_leases += 1;
  }

  DocumentLease &operator=(DocumentLease &&other) noexcept {
    if (this != &other) {
      release();
      document_id_ = other.document_id_;
      save_count_ = other.save_count_;
      active_ = other.active_;
      other.active_ = false;
      moved_document_leases += 1;
    }
    return *this;
  }

  ~DocumentLease() {
    release();
  }

  int32_t documentId() const & {
    return document_id_;
  }

  void recordSave() & {
    if (active_) save_count_ += 1;
  }

  int32_t saveCount() const & {
    return save_count_;
  }

  static int32_t liveCount() {
    return live_document_leases;
  }

  static int32_t moveCount() {
    return moved_document_leases;
  }

private:
  void release() {
    if (!active_) return;
    active_ = false;
    live_document_leases -= 1;
  }

  int32_t document_id_;
  int32_t save_count_;
  bool active_;
};

} // namespace desktop
