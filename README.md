# Wayfarer v2 – AI Travel Planner

Express + Postgres (Neon) + accounts + live weather and exchange rates + any OpenAI-compatible AI provider.

## Run locally
1. `npm install`
2. Copy `.env.example` to `.env` and fill in every value
3. `npm start` → http://localhost:3000

## Deploy free (Render + Neon)
1. Create a free Postgres database at neon.tech and copy its connection string into DATABASE_URL.
2. Push this folder to GitHub (`.env` is ignored by `.gitignore`).
3. On render.com create a Web Service from the repo: build `npm install`, start `npm start`, free plan.
4. Add the same variables from `.env` under Environment.
