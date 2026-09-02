// tailwind.config.cjs — the source of the committed stylesheet, public/css/tailwind.css.
//
// Rebuild after ANY change to a class in public/**/*.{html,js} or to this file:
//   npx --yes tailwindcss@3.4.17 -c tailwind.config.cjs -i scripts/tailwind-input.css -o public/css/tailwind.css --minify
// The stylesheet is committed and served as a static asset; there is no build step at deploy time.
//
// THE PALETTE LIVES HERE. It used to sit in `tailwind.config = {…}` beside the CDN script in
// index.html; when Tailwind became a committed, precompiled stylesheet the same object moved to this
// file unchanged. Everything CLAUDE.md says about the scale names still holds: `indigo`/`purple`/
// `pink` are the BRAND RAMP slots and carry champagne gold, `emerald`/`amber`/`rose` are the
// SEMANTIC slots (pass / partial / fail), `slate` is the parchment-and-ink chassis. Read the role,
// never the name.
module.exports = {
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Plus Jakarta Sans"', 'Inter', 'ui-sans-serif', 'sans-serif'],
      },
      // ---- THE PALETTE LIVES HERE, AND THE SCALE NAMES ARE TAILWIND'S, NOT DESCRIPTIONS. ----
      // Every colour in this app is a Tailwind utility (~1,600 of them across 27 files), so
      // the palette is changed by REDEFINING THE SCALES rather than by rewriting the classes.
      // `indigo`/`purple`/`pink` are the BRAND RAMP SLOTS and now carry champagne gold;
      // `emerald`/`amber`/`rose` are the SEMANTIC SLOTS and still mean pass / partial / fail;
      // `slate` is the warm parchment-and-ink chassis. A class named `indigo-600` is the
      // brand's action colour — it is not indigo, and nothing should be read from the name.
      //
      // Rewriting the classes instead would have cost 1,600 edits AND broken verify-ui.mjs,
      // which asserts on `from-indigo-500` (the freshness hero) and `bg-indigo-500` (the live
      // pill) — those assertions are about the ROLE, and the role has not moved.
      colors: {
        // Parchment → ink. 50–200 are surfaces and hairlines, 300 is the glyph tier
        // (em dashes, sort carets, the hollow watchlist star), 400–900 is text.
        slate: {
          50: '#faf8f1',
          100: '#efeadd',
          200: '#e4ddcd',
          300: '#928da1',
          400: '#736f88',
          500: '#6b6880',
          600: '#55516b',
          700: '#3d3a52',
          800: '#26233d',
          900: '#1a1830',
        },
        // Brand ramp start — champagne. 400/500 are FILLS, 600+ are the only steps that may
        // carry text: #b8923c under small text is 2.9:1, so it is deliberately absent here.
        indigo: {
          50: '#fbf7ec',
          100: '#f4ecd8',
          200: '#ecdcae',
          300: '#ddc998',
          400: '#d9c48f',
          500: '#c3a962',
          600: '#8a6a1c',
          700: '#7d5f16',
          800: '#5f4711',
          900: '#43320b',
        },
        // Brand ramp middle.
        purple: {
          50: '#fdf9f0',
          100: '#f7efdc',
          200: '#efe0bb',
          300: '#e6d3a3',
          400: '#dfcb99',
          500: '#d9c48f',
          600: '#b8923c',
          700: '#8a6a1c',
          800: '#6f5415',
          900: '#5f4711',
        },
        // Brand ramp end.
        pink: {
          50: '#fdfaf3',
          100: '#f9f2e2',
          200: '#f3e7c9',
          300: '#efe0b9',
          400: '#eedfb4',
          500: '#ecdcae',
          600: '#c3a962',
          700: '#8a6a1c',
          800: '#6f5415',
          900: '#5f4711',
        },
        // Semantic — pass.
        emerald: {
          50: '#e8f3ee',
          100: '#d3e8de',
          200: '#a9d3c0',
          300: '#6bb99b',
          400: '#199e70',
          500: '#0b8a5f',
          600: '#047857',
          700: '#045f45',
          800: '#044a37',
          900: '#033a2b',
        },
        // Semantic — partial. Browner and more orange than the brand gold on purpose:
        // see the note in CLAUDE.md about the one adjacency this palette has to hold.
        amber: {
          50: '#fdf3e2',
          100: '#fbe8c8',
          200: '#f5d193',
          300: '#e2ac4e',
          400: '#c98a1c',
          500: '#b4780f',
          600: '#9a5c09',
          700: '#92560a',
          800: '#7a4708',
          900: '#5e3606',
        },
        // Semantic — fail.
        rose: {
          50: '#fdecec',
          100: '#fbdada',
          200: '#f4b4b4',
          300: '#e58a8a',
          400: '#d55555',
          500: '#c92a2a',
          600: '#b91c1c',
          700: '#991b1b',
          800: '#7f1d1d',
          900: '#651414',
        },
        // The two cool families used decoratively (never semantically) are pulled onto the
        // chart palette so a stray swatch cannot be the one cold thing on an ivory page.
        // The three decorative accents that survive as their own hue — panel and provenance
        // tints that need to differ from each other, not to mean anything. Warm-shifted so
        // they sit on parchment, with every text step at AA (5.0–12.4:1 on white).
        violet: { 50: '#f6f2fb', 100: '#ece4f7', 200: '#d9c9ef', 300: '#c0a8e3', 400: '#9d7dd1', 500: '#7f5cc2', 600: '#6d4bb5', 700: '#5b3f9e', 800: '#4a3480', 900: '#3a2a63' },
        sky: { 50: '#eef6f9', 100: '#daebf2', 200: '#b2d7e6', 300: '#7fbdd4', 400: '#3f9dbe', 500: '#1a83a5', 600: '#12768f', 700: '#0d6a86', 800: '#0b566d', 900: '#09455a' },
        teal: { 50: '#eef6f4', 100: '#d8ece7', 200: '#a9d6cd', 300: '#6fbcae', 400: '#2b9d8a', 500: '#158b78', 600: '#0f7d6c', 700: '#0d6659', 800: '#0b5348', 900: '#08423a' },
        blue: { 50: '#eef0fd', 100: '#dfe2fb', 200: '#c3c8f7', 300: '#a3abf3', 400: '#818cf8', 500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81' },
        fuchsia: { 50: '#fdeef4', 100: '#fbdde9', 200: '#f4b9cd', 300: '#ea94b1', 400: '#e0709b', 500: '#d4527f', 600: '#b93d67', 700: '#992f53', 800: '#7c2743', 900: '#661f37' },
      },
    },
  },
};
