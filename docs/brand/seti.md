# Seti

Seti is Setra's mascot, a friendly blue ledger with a folded corner.

- Official renders, one per expression (transparent, 1254px): `docs/brand/seti/<mood>.webp`
- The original expression sheet, for reference: `seti-expression-study.webp`
- `scripts/prepare-seti.py` turns the renders into web images (`apps/web/public/seti/`, trimmed,
  560px tall). It also finds Seti's eyes (`apps/web/src/components/seti-eyes.ts`), so the app can
  make Seti blink. Re-run it whenever the renders change.

In the app, always use the component:

```tsx
import { Seti } from "@/components/seti";

<Seti mood="welcome" size={120} />
```

## How Seti moves

Seti stays grounded: there's no bouncing or vertical travel. Instead:

- it **breathes** (a slight stretch from its feet) and **sways** gently in a way that suits the
  mood: a friendly lean for welcome, a happy wiggle for success, a head tilt for curious;
- it **blinks** every few seconds, sometimes twice, on the open-eyed expressions (welcome,
  focused, curious, attention);
- it **turns a little toward the pointer** in 3D on hover;
- it fades in the first time it's seen.

Everything stops with the system "Reduce motion" setting. Seti is decorative by default; pass
`decorative={false}` when Seti carries meaning, so it gets alt text.

Real limb animation (waving arms, walking) would need a rigged 3D model or a Rive/Lottie
character file, which a flat render can't provide. If that artwork exists later, it can replace
the image inside the same `Seti` component without changing any page.

## Moods and where they appear

| Mood | Meaning | Used for |
|---|---|---|
| `welcome` | Hello | Website and Product heroes, sign-in and sign-up, console greeting, first-run empty states, Assistant greeting and avatar |
| `focused` | Working on it | Developers page and Docs home, loading the workspace, onboarding wallet and invoice steps, the Assistant while it works, "add a wallet first" |
| `success` | It worked | Onboarding finish ("ready to pay"), website call to action, the paid-pilot offer on Pricing |
| `curious` | Let's look | Pricing hero ("which plan?"), search with no results, 404, empty developer lists, "Setra never guesses" on the website |
| `attention` | Something needs you | "What Setra doesn't do" on Product, errors ("couldn't load this", the error page, service unavailable) |
| `resting` | All clear | Security page (calm, nothing to worry about), "Nothing needs attention", no notifications, an invoice waiting for payment |

## Guidelines

- One Seti per view, at the moment it adds warmth (a welcome, an empty state, an error, a win).
  Don't put Seti in dense tables, forms or financial detail.
- Seti never appears on the hosted payment page. That page belongs to the merchant and their
  customer, so it stays merchant-branded apart from "Powered by Setra".
- Use `attention` for problems, never a sad or alarmed Seti for normal financial states like a
  partial payment. Those are routine, and the UI treats them calmly.
- Don't recolour, stretch or crop Seti. Size it with `size` (height in px).
