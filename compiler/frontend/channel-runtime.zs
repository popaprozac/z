// Native bounded MPSC runtime emission. Async waiter queues are a separate tier.
import { TextBuffer } from "std/text";

export function channelHandleDefinitions(in id: String): String {
  let output = TextBuffer();
  output.append(`typedef struct Z_ChannelStorage_${id} Z_ChannelStorage_${id};\n`);
  const kinds = Array<String>("Sender", "Receiver", "SyncSender", "SyncReceiver");
  for (const kind of kinds) {
    output.append(`typedef struct { Z_ChannelStorage_${id} *storage; } Z___z_Channel_${kind}_${id};\n`);
  }
  return output.finish();
}

export function channelRuntimeDeclarations(in id: String, in value: String): String {
  let output = TextBuffer();
  const kinds = Array<String>("Sender", "Receiver", "SyncSender", "SyncReceiver");
  for (const kind of kinds) {
    output.append(`static __attribute__((unused)) void Z___z_Channel_${kind}_${id}_deinit(Z___z_Channel_${kind}_${id} *self);\n`);
  }
  const senders = Array<String>("Sender", "SyncSender");
  for (const kind of senders) {
    output.append(`static __attribute__((unused)) Z___z_Channel_${kind}_${id} Z___z_Channel_${kind}_${id}_retain(Z___z_Channel_${kind}_${id} self);\n`);
    output.append(`static __attribute__((unused)) void Z___z_Channel_${kind}_${id}_close(Z___z_Channel_${kind}_${id} self);\n`);
  }
  output.append(`static __attribute__((unused)) Z___z_Channel_Endpoints_${id} Z___z_Channel_Endpoints_${id}_bounded(size_t capacity);
static __attribute__((unused)) Z___z_Channel_SyncSender_${id} Z___z_Channel_Sender_${id}_sync(Z___z_Channel_Sender_${id} self);
static __attribute__((unused)) Z___z_Channel_SyncReceiver_${id} Z___z_Channel_Receiver_${id}_sync(Z___z_Channel_Receiver_${id} self);
static __attribute__((unused)) Z___z_Result_void___z_Channel_Closed_${id} Z___z_Channel_SyncSender_${id}_send(Z___z_Channel_SyncSender_${id} self, ${value} value);
static __attribute__((unused)) Z___z_Option_${id} Z___z_Channel_SyncReceiver_${id}_receive(Z___z_Channel_SyncReceiver_${id} self);
`);
  return output.finish();
}

export function channelRuntimeDefinitions(in id: String, in value: String, in cleanup: String): String {
  let output = TextBuffer();
  output.append(`struct Z_ChannelStorage_${id} {
#if defined(_WIN32)
  SRWLOCK mutex;
  CONDITION_VARIABLE readable, writable;
#else
  pthread_mutex_t mutex;
  pthread_cond_t readable, writable;
#endif
  size_t references, senders, capacity, head, tail, length;
  bool closed;
  ${value} *items;
};
static void z_channel_${id}_lock(Z_ChannelStorage_${id} *s) {
  if (s == NULL) abort();
#if defined(_WIN32)
  AcquireSRWLockExclusive(&s->mutex);
#else
  if (pthread_mutex_lock(&s->mutex) != 0) abort();
#endif
}
static void z_channel_${id}_unlock(Z_ChannelStorage_${id} *s) {
#if defined(_WIN32)
  ReleaseSRWLockExclusive(&s->mutex);
#else
  if (pthread_mutex_unlock(&s->mutex) != 0) abort();
#endif
}
static void z_channel_${id}_close(Z_ChannelStorage_${id} *s) {
  z_channel_${id}_lock(s);
  s->closed = true;
#if defined(_WIN32)
  WakeAllConditionVariable(&s->readable);
  WakeAllConditionVariable(&s->writable);
#else
  if (pthread_cond_broadcast(&s->readable) != 0) abort();
  if (pthread_cond_broadcast(&s->writable) != 0) abort();
#endif
  z_channel_${id}_unlock(s);
}
static void z_channel_${id}_release(Z_ChannelStorage_${id} *s) {
  if (__atomic_sub_fetch(&s->references, 1, __ATOMIC_ACQ_REL) != 0) return;
  while (s->length > 0) {
    size_t index = s->head;
    (void)index;
    ${cleanup}
    s->head = (s->head + 1) % s->capacity;
    s->length -= 1;
  }
#if !defined(_WIN32)
  if (pthread_cond_destroy(&s->readable) != 0) abort();
  if (pthread_cond_destroy(&s->writable) != 0) abort();
  if (pthread_mutex_destroy(&s->mutex) != 0) abort();
#endif
  free(s->items);
  free(s);
}
static __attribute__((unused)) Z___z_Channel_Endpoints_${id} Z___z_Channel_Endpoints_${id}_bounded(size_t capacity) {
  if (capacity == 0 || capacity > SIZE_MAX / sizeof(${value})) abort();
  Z_ChannelStorage_${id} *s = calloc(1, sizeof(*s));
  if (s == NULL) abort();
  s->items = calloc(capacity, sizeof(${value}));
  if (s->items == NULL) { free(s); abort(); }
#if defined(_WIN32)
  InitializeSRWLock(&s->mutex);
  InitializeConditionVariable(&s->readable);
  InitializeConditionVariable(&s->writable);
#else
  if (pthread_mutex_init(&s->mutex, NULL) != 0
    || pthread_cond_init(&s->readable, NULL) != 0
    || pthread_cond_init(&s->writable, NULL) != 0) abort();
#endif
  s->references = 2;
  s->senders = 1;
  s->capacity = capacity;
  return (Z___z_Channel_Endpoints_${id}){ .sender = { .storage = s }, .receiver = { .storage = s } };
}
`);
  const kinds = Array<String>("Sender", "Receiver", "SyncSender", "SyncReceiver");
  for (const kind of kinds) {
    const sender = kind == "Sender" || kind == "SyncSender";
    output.append(`static __attribute__((unused)) void Z___z_Channel_${kind}_${id}_deinit(Z___z_Channel_${kind}_${id} *self) {
  if (self == NULL || self->storage == NULL) return;
  Z_ChannelStorage_${id} *s = self->storage;
  self->storage = NULL;
`);
    if (sender) {
      output.append(`  if (__atomic_sub_fetch(&s->senders, 1, __ATOMIC_ACQ_REL) == 0) z_channel_${id}_close(s);\n`);
    } else output.append(`  z_channel_${id}_close(s);\n`);
    output.append(`  z_channel_${id}_release(s);\n}\n`);
    if (sender) {
      output.append(`static __attribute__((unused)) Z___z_Channel_${kind}_${id} Z___z_Channel_${kind}_${id}_retain(Z___z_Channel_${kind}_${id} self) {
  if (self.storage == NULL) abort();
  __atomic_add_fetch(&self.storage->references, 1, __ATOMIC_RELAXED);
  __atomic_add_fetch(&self.storage->senders, 1, __ATOMIC_RELAXED);
  return self;
}
static __attribute__((unused)) void Z___z_Channel_${kind}_${id}_close(Z___z_Channel_${kind}_${id} self) { z_channel_${id}_close(self.storage); }
`);
    }
  }
  output.append(`static __attribute__((unused)) Z___z_Channel_SyncSender_${id} Z___z_Channel_Sender_${id}_sync(Z___z_Channel_Sender_${id} self) {
  self = Z___z_Channel_Sender_${id}_retain(self);
  return (Z___z_Channel_SyncSender_${id}){ .storage = self.storage };
}
static __attribute__((unused)) Z___z_Channel_SyncReceiver_${id} Z___z_Channel_Receiver_${id}_sync(Z___z_Channel_Receiver_${id} self) {
  if (self.storage == NULL) abort();
  return (Z___z_Channel_SyncReceiver_${id}){ .storage = self.storage };
}
static __attribute__((unused)) Z___z_Result_void___z_Channel_Closed_${id} Z___z_Channel_SyncSender_${id}_send(Z___z_Channel_SyncSender_${id} self, ${value} value) {
  Z_ChannelStorage_${id} *s = self.storage;
  z_channel_${id}_lock(s);
  while (s->length == s->capacity && !s->closed) {
#if defined(_WIN32)
    if (!SleepConditionVariableSRW(&s->writable, &s->mutex, INFINITE, 0)) abort();
#else
    if (pthread_cond_wait(&s->writable, &s->mutex) != 0) abort();
#endif
  }
  if (s->closed) {
    z_channel_${id}_unlock(s);
    return (Z___z_Result_void___z_Channel_Closed_${id}){ .tag = Z___z_Result_void___z_Channel_Closed_${id}Tag_failure, .payload.failure = { .value = value } };
  }
  s->items[s->tail] = value;
  s->tail = (s->tail + 1) % s->capacity;
  s->length += 1;
#if defined(_WIN32)
  WakeConditionVariable(&s->readable);
#else
  if (pthread_cond_signal(&s->readable) != 0) abort();
#endif
  z_channel_${id}_unlock(s);
  return (Z___z_Result_void___z_Channel_Closed_${id}){ .tag = Z___z_Result_void___z_Channel_Closed_${id}Tag_success };
}
static __attribute__((unused)) Z___z_Option_${id} Z___z_Channel_SyncReceiver_${id}_receive(Z___z_Channel_SyncReceiver_${id} self) {
  Z_ChannelStorage_${id} *s = self.storage;
  z_channel_${id}_lock(s);
  while (s->length == 0 && !s->closed) {
#if defined(_WIN32)
    if (!SleepConditionVariableSRW(&s->readable, &s->mutex, INFINITE, 0)) abort();
#else
    if (pthread_cond_wait(&s->readable, &s->mutex) != 0) abort();
#endif
  }
  if (s->length == 0) {
    z_channel_${id}_unlock(s);
    return (Z___z_Option_${id}){ .tag = Z___z_Option_${id}Tag_none };
  }
  ${value} value = s->items[s->head];
  s->head = (s->head + 1) % s->capacity;
  s->length -= 1;
#if defined(_WIN32)
  WakeConditionVariable(&s->writable);
#else
  if (pthread_cond_signal(&s->writable) != 0) abort();
#endif
  z_channel_${id}_unlock(s);
  return (Z___z_Option_${id}){ .tag = Z___z_Option_${id}Tag_some, .payload.some = value };
}
`);
  return output.finish();
}
