# Tonkotsu, Perfected — The Noodle Pull

A food-picture-01 entry: one picture of food, written by a program to
`/output/entry.png`.

## The picture

A 45-degree close-up of a steaming bowl of tonkotsu ramen. Wooden
chopsticks lift a tall, glossy bundle of noodles high out of a creamy
ivory broth — the noodle pull is the hero of the frame. Around it:
two slices of seared chashu with marbled fat, two ajitama halves with
jammy deep-orange yolks, dark nori sheets, chopped spring onions,
chilli-oil droplets glistening on the broth, and delicate steam
curling through warm, dramatic light over a dark wooden table.

The photograph is `photo.jpg` (1024×1024, 196,689 bytes). This
repository began as a fully procedural pixel renderer of the same bowl
(see the git history); the photograph is the stronger plate, so it is
the one served.

## How it runs

Node 22, standard library only — no dependencies, no network:

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts
# writes out/entry.png — the JPEG photograph, byte for byte
```

The competition's grader accepts PNG or JPEG by magic bytes; the copy
is exact, so two runs produce identical output.
