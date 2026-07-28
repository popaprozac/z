import { TextBuffer } from "std/text";

function rotateRight(value: u32, amount: u32): u32 {
  const leftFactor = u32(1) << (32 - amount);
  return (value >> amount) | value.wrappingMultiply(leftFactor);
}

function appendHexDigit(inout output: TextBuffer, value: u8): void {
  if (value < 10) {
    output.appendAscii(48 + value);
  } else {
    output.appendAscii(87 + value);
  }
}

function appendHexU32(inout output: TextBuffer, value: u32): void {
  let shift: u32 = 28;
  while (true) {
    appendHexDigit(inout output, u8((value >> shift) & 15));
    if (shift == 0) return;
    shift = shift - 4;
  }
}

export function sha256(in bytes: Array<u8>): String {
  let roundConstants = Array<u32>();
  roundConstants.push(1116352408);
  roundConstants.push(1899447441);
  roundConstants.push(3049323471);
  roundConstants.push(3921009573);
  roundConstants.push(961987163);
  roundConstants.push(1508970993);
  roundConstants.push(2453635748);
  roundConstants.push(2870763221);
  roundConstants.push(3624381080);
  roundConstants.push(310598401);
  roundConstants.push(607225278);
  roundConstants.push(1426881987);
  roundConstants.push(1925078388);
  roundConstants.push(2162078206);
  roundConstants.push(2614888103);
  roundConstants.push(3248222580);
  roundConstants.push(3835390401);
  roundConstants.push(4022224774);
  roundConstants.push(264347078);
  roundConstants.push(604807628);
  roundConstants.push(770255983);
  roundConstants.push(1249150122);
  roundConstants.push(1555081692);
  roundConstants.push(1996064986);
  roundConstants.push(2554220882);
  roundConstants.push(2821834349);
  roundConstants.push(2952996808);
  roundConstants.push(3210313671);
  roundConstants.push(3336571891);
  roundConstants.push(3584528711);
  roundConstants.push(113926993);
  roundConstants.push(338241895);
  roundConstants.push(666307205);
  roundConstants.push(773529912);
  roundConstants.push(1294757372);
  roundConstants.push(1396182291);
  roundConstants.push(1695183700);
  roundConstants.push(1986661051);
  roundConstants.push(2177026350);
  roundConstants.push(2456956037);
  roundConstants.push(2730485921);
  roundConstants.push(2820302411);
  roundConstants.push(3259730800);
  roundConstants.push(3345764771);
  roundConstants.push(3516065817);
  roundConstants.push(3600352804);
  roundConstants.push(4094571909);
  roundConstants.push(275423344);
  roundConstants.push(430227734);
  roundConstants.push(506948616);
  roundConstants.push(659060556);
  roundConstants.push(883997877);
  roundConstants.push(958139571);
  roundConstants.push(1322822218);
  roundConstants.push(1537002063);
  roundConstants.push(1747873779);
  roundConstants.push(1955562222);
  roundConstants.push(2024104815);
  roundConstants.push(2227730452);
  roundConstants.push(2361852424);
  roundConstants.push(2428436474);
  roundConstants.push(2756734187);
  roundConstants.push(3204031479);
  roundConstants.push(3329325298);

  let padded = Array<u8>();
  for (const byte of bytes) {
    padded.push(byte);
  }
  padded.push(128);
  while ((padded.length % 64) != 56) {
    padded.push(0);
  }

  const bitLength: u64 = u64(bytes.length) * 8;
  padded.push(u8((bitLength >> 56) & 255));
  padded.push(u8((bitLength >> 48) & 255));
  padded.push(u8((bitLength >> 40) & 255));
  padded.push(u8((bitLength >> 32) & 255));
  padded.push(u8((bitLength >> 24) & 255));
  padded.push(u8((bitLength >> 16) & 255));
  padded.push(u8((bitLength >> 8) & 255));
  padded.push(u8(bitLength & 255));

  let first: u32 = 1779033703;
  let second: u32 = 3144134277;
  let third: u32 = 1013904242;
  let fourth: u32 = 2773480762;
  let fifth: u32 = 1359893119;
  let sixth: u32 = 2600822924;
  let seventh: u32 = 528734635;
  let eighth: u32 = 1541459225;

  let chunk: usize = 0;
  while (chunk < padded.length) {
    let schedule = Array<u32>();
    let index: usize = 0;
    while (index < 16) {
      const offset = chunk + (index * 4);
      schedule.push(
        (u32(padded[offset]) << 24)
          | (u32(padded[offset + 1]) << 16)
          | (u32(padded[offset + 2]) << 8)
          | u32(padded[offset + 3])
      );
      index = index + 1;
    }
    while (index < 64) {
      const earlier = schedule[index - 15];
      const later = schedule[index - 2];
      const sigma0 = rotateRight(earlier, 7)
        ^ rotateRight(earlier, 18)
        ^ (earlier >> 3);
      const sigma1 = rotateRight(later, 17)
        ^ rotateRight(later, 19)
        ^ (later >> 10);
      schedule.push(
        schedule[index - 16]
          .wrappingAdd(sigma0)
          .wrappingAdd(schedule[index - 7])
          .wrappingAdd(sigma1)
      );
      index = index + 1;
    }

    let a = first;
    let b = second;
    let c = third;
    let d = fourth;
    let e = fifth;
    let f = sixth;
    let g = seventh;
    let h = eighth;
    index = 0;
    while (index < 64) {
      const sum1 = rotateRight(e, 6)
        ^ rotateRight(e, 11)
        ^ rotateRight(e, 25);
      const choose = (e & f) ^ ((~e) & g);
      const temporary1 = h
        .wrappingAdd(sum1)
        .wrappingAdd(choose)
        .wrappingAdd(roundConstants[index])
        .wrappingAdd(schedule[index]);
      const sum0 = rotateRight(a, 2)
        ^ rotateRight(a, 13)
        ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = sum0.wrappingAdd(majority);

      h = g;
      g = f;
      f = e;
      e = d.wrappingAdd(temporary1);
      d = c;
      c = b;
      b = a;
      a = temporary1.wrappingAdd(temporary2);
      index = index + 1;
    }

    first = first.wrappingAdd(a);
    second = second.wrappingAdd(b);
    third = third.wrappingAdd(c);
    fourth = fourth.wrappingAdd(d);
    fifth = fifth.wrappingAdd(e);
    sixth = sixth.wrappingAdd(f);
    seventh = seventh.wrappingAdd(g);
    eighth = eighth.wrappingAdd(h);
    chunk = chunk + 64;
  }

  let output = TextBuffer();
  appendHexU32(inout output, first);
  appendHexU32(inout output, second);
  appendHexU32(inout output, third);
  appendHexU32(inout output, fourth);
  appendHexU32(inout output, fifth);
  appendHexU32(inout output, sixth);
  appendHexU32(inout output, seventh);
  appendHexU32(inout output, eighth);
  return output.finish();
}
