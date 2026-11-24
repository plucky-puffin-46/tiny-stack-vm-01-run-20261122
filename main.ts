// Tiny stack VM for make.fun's tiny-stack-vm-01: runs every program in the
// input dir on the kit ISA's stack machine and writes its exact output bytes
// and exit code, following the reference step order and trap codes exactly.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Per-opcode facts as digit strings indexed by opcode byte: immediate length
// (9 = not an opcode), pops, pushes.
const IM = '0140000099999999' + '0000000000000009' + '0009999999999999' + '2222099999999999' + '0099999999999999' + '0000';
const PP = '0001122300000000' + '2222222122212220' + '2220000000000000' + '0110000000000000' + '1200000000000000' + '1101';
const PS = '0110223300000000' + '1111111111111110' + '1110000000000000' + '0000000000000000' + '1000000000000000' + '0010';

function run(P, I) {
  const S = new Int32Array(256), C = new Int32Array(64), M = new Int32Array(256), O = new Uint8Array(65536);
  const n = P.length;
  let sp = 0, cp = 0, ol = 0, ip = 0, pc = 0, st = 0;
  const end = (c) => ({ o: O.slice(0, ol), c });
  for (;;) {
    if (st === 1e6) return end(10);
    if (pc < 0 || pc >= n) return end(9);
    const op = P[pc];
    if (op > 83) return end(5);
    const im = IM.charCodeAt(op) - 48;
    if (im === 9) return end(5);
    if (pc + im >= n) return end(9);
    st++;
    const pp = PP.charCodeAt(op) - 48;
    if (sp < pp) return end(2);
    if (sp - pp + PS.charCodeAt(op) - 48 > 256) return end(3);
    const nx = pc + 1 + im;
    pc = nx;
    switch (op) {
      case 0: return end(0); // HALT
      case 1: S[sp++] = (P[nx - 1] << 24) >> 24; break; // PUSH8, sign-extended
      case 2: S[sp++] = P[nx - 4] | P[nx - 3] << 8 | P[nx - 2] << 16 | P[nx - 1] << 24; break; // PUSH32
      case 3: sp--; break; // POP
      case 4: S[sp] = S[sp - 1]; sp++; break; // DUP
      case 5: { const t = S[sp - 1]; S[sp - 1] = S[sp - 2]; S[sp - 2] = t; break; } // SWAP
      case 6: S[sp] = S[sp - 2]; sp++; break; // OVER
      case 7: { const a = S[sp - 3]; S[sp - 3] = S[sp - 2]; S[sp - 2] = S[sp - 1]; S[sp - 1] = a; break; } // ROT
      case 23: S[sp - 1] = -S[sp - 1] | 0; break; // NEG
      case 27: S[sp - 1] = ~S[sp - 1]; break; // NOT
      case 16: case 17: case 18: case 19: case 20: case 21: case 22:
      case 24: case 25: case 26: case 28: case 29: case 30:
      case 32: case 33: case 34: {
        const b = S[sp - 1], a = S[sp - 2]; // b is the top, a under it
        let r;
        if (op === 16) r = (a + b) | 0; // ADD
        else if (op === 17) r = (a - b) | 0; // SUB
        else if (op === 18) r = Math.imul(a, b); // MUL, exact low 32 bits
        else if (op === 19) { if (!b) return end(4); r = a === -2147483648 && b === -1 ? a : (a / b) | 0; } // DIV
        else if (op === 20) { if (!b) return end(4); r = b === -1 ? 0 : a % b | 0; } // MOD, dividend's sign
        else if (op === 21) { if (!b) return end(4); r = Math.floor((a >>> 0) / (b >>> 0)) | 0; } // DIVU
        else if (op === 22) { if (!b) return end(4); r = (a >>> 0) % (b >>> 0) | 0; } // MODU
        else if (op === 24) r = a & b; // AND
        else if (op === 25) r = a | b; // OR
        else if (op === 26) r = a ^ b; // XOR
        else if (op === 28) r = a << (b & 31); // SHL, low 5 bits of count
        else if (op === 29) r = a >> (b & 31); // SHR, arithmetic
        else if (op === 30) r = (a >>> (b & 31)) | 0; // SHRU, logical
        else if (op === 32) r = a === b ? 1 : 0; // EQ
        else if (op === 33) r = a < b ? 1 : 0; // LT, signed
        else r = (a >>> 0) < (b >>> 0) ? 1 : 0; // LTU, unsigned
        sp--;
        S[sp - 1] = r;
        break;
      }
      case 48: case 49: case 50: { // JMP / JZ / JNZ, signed relative offset
        const rel = ((P[nx - 2] | P[nx - 1] << 8) << 16) >> 16;
        if (op === 48 || (S[--sp] === 0) === (op === 49)) pc = nx + rel;
        break;
      }
      case 51: // CALL, unsigned absolute target
        if (cp === 64) return end(7);
        C[cp++] = nx;
        pc = P[nx - 2] | P[nx - 1] << 8;
        break;
      case 52: // RET
        if (!cp) return end(8);
        pc = C[--cp];
        break;
      case 64: { // LOAD, address on top
        const a = S[sp - 1];
        if (a < 0 || a > 255) return end(6);
        S[sp - 1] = M[a];
        break;
      }
      case 65: { // STORE, value under the address
        const a = S[sp - 1];
        if (a < 0 || a > 255) return end(6);
        M[a] = S[sp - 2];
        sp -= 2;
        break;
      }
      case 80: { // PRINT, decimal with no newline; all of it or trap 11
        const t = String(S[sp - 1]);
        if (ol + t.length > 65536) return end(11);
        sp--;
        for (let i = 0; i < t.length; i++) O[ol++] = t.charCodeAt(i);
        break;
      }
      case 81: // PUTC, low byte only
        if (ol === 65536) return end(11);
        O[ol++] = S[--sp] & 255;
        break;
      case 82: // IN, -1 once the input is used up
        S[sp++] = ip < I.length ? I[ip++] : -1;
        break;
      case 83: return end(S[--sp] & 255); // EXIT, low byte is the code
    }
  }
}

const A = process.env.MAKEFUN_INPUT_DIR ?? '/input', B = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(A).sort()) {
  const r = run(new Uint8Array(readFileSync(join(A, id, 'program.bin'))), new Uint8Array(readFileSync(join(A, id, 'input.bin'))));
  mkdirSync(join(B, id), { recursive: true });
  writeFileSync(join(B, id, 'stdout.bin'), r.o);
  writeFileSync(join(B, id, 'exit.txt'), r.c + '\n');
}
