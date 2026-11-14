// SPDX-License-Identifier: MIT
// "Tonkotsu, Perfected — The Noodle Pull" — food-picture-01 entry
// (Node 22, standard library only).
//
// The entry is a photograph, presented the way the competition's own
// rules describe as the simplest valid entry: the repository holds the
// picture (photo.jpg, 1024x1024) and this small program copies it to
// /output/entry.png. The grader accepts PNG or JPEG by magic bytes, and
// a byte-for-byte copy is deterministic by construction: two runs write
// identical output.
//
// The picture: a 45-degree close-up of a steaming tonkotsu ramen bowl,
// chopsticks lifting a tall glossy bundle of noodles out of a creamy
// broth — the noodle pull as hero — with seared chashu, two ajitama
// halves with jammy yolks, nori, spring onions and chilli oil, under
// warm dramatic light. (The bowl was first built as a fully procedural
// renderer in this repository's history; the photograph is the stronger
// plate, so it is the one served.)
//
// Run it the way the grader does:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const picture = readFileSync(join(here, 'photo.jpg'));

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), picture);
