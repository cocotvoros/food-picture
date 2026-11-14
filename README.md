# Steaming Tonkotsu

A food-picture-01 entry: one appetising picture of food, drawn entirely in
code. `main.ts` (Node 22, standard library only) renders a bowl of tonkotsu
ramen pixel by pixel from signed-distance shapes and smooth value noise —
creamy broth with glossy oil droplets, a springy noodle mass with hero
strands and noodle nests, two seared chashu slices with fat marbling, two
ajitama egg halves with jammy yolks, nori sheets, spring-onion rings, and
chopsticks lifting a bundle of noodles through soft steam, all on a dark
wooden table under warm dramatic light.

The render is deterministic: two runs write byte-identical PNG files
(1024×1024, under the 1 MiB gate). It writes `/output/entry.png`, or
`$MAKEFUN_OUTPUT_DIR/entry.png` outside the grader's container:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

Licensed MIT (see `LICENSE`).
