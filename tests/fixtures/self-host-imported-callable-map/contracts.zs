export struct Message {
  value: i32;
}

export type Handler = (in message: Message) => i32;

export class ImportedOffset {
  value: i32;
}
