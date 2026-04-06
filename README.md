# ClearGains

An educational trading portfolio tracker for UK investors with CGT calculations, AI-powered stock analysis, and tax filing guidance.

> **Disclaimer:** ClearGains is an educational simulation tool only. It is not regulated by the FCA and does not constitute financial or tax advice. Always verify tax calculations with a qualified adviser before filing.

## Features

- **Trading 212 Integration** — sync your live or demo portfolio via the T212 REST API
- **CGT Calculator** — HMRC-compliant Section 104 pooling, same-day rule, and 30-day bed & breakfast rule
- **AI Scanner** — Claude AI with web search analyses any stock ticker (BUY / SELL / HOLD signals)
- **Risk Engine** — portfolio concentration (HHI), 1-day VaR estimate, and UK compliance checks
- **Trade Ledger** — manual trade entry or import from Trading 212, with ISA wrapper support
- **Tax Guides** — country-specific CGT rates and filing deadlines for 12 countries
- **Multi-country** — UK, US, Germany, France, Australia, Canada, Ireland, Netherlands, Spain, Italy, Portugal, Sweden

## Getting Started

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

Create a `.env.local` file in the project root:

```env
# Required for Trading 212 portfolio sync
T212_API_KEY=your_trading212_api_key

# Required for AI Scanner (falls back to simulated signals without it)
ANTHROPIC_API_KEY=your_anthropic_api_key

# Optional: live FX rates (falls back to hardcoded rates without it)
FX_API_KEY=your_exchangerate_api_key
```

### Getting your API keys

| Key | Where to get it |
|-----|----------------|
| `T212_API_KEY` | Trading 212 → Settings → API (generate a read-only key) |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) |
| `FX_API_KEY` | [exchangerate-api.com](https://www.exchangerate-api.com) (free tier available) |

## Tech Stack

- **Framework:** Next.js 16 (App Router, Turbopack)
- **Language:** TypeScript
- **Styling:** Tailwind CSS v4
- **State:** Zustand (persisted to localStorage)
- **AI:** Anthropic Claude with web search tool
- **Icons:** Lucide React

## Deploy on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new)

Set the three environment variables above in your Vercel project settings before deploying.
# build fix
