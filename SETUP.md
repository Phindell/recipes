# Family Recipes — setup guide

About 30–45 minutes, all from your Windows PC in a web browser. Nothing to install.

| Step | What | Cost |
|---|---|---|
| 1 | Put the app on GitHub Pages (works straight away in demo mode) | Free |
| 2–4 | Supabase: shared database, photos, family logins | Free |
| 5 | Smart import (Instagram, TikTok, YouTube, text, photos) | ~0.15¢ per import |
| 6 | Keep-awake ping | Free |
| 7 | Add to iPhones/iPads + Share-sheet shortcut | Free |

---

## 1. Put the app on GitHub Pages

1. Unzip `recipe-app.zip` on your PC.
2. On github.com → **New repository** → name it `recipes` → **Public** → Create.
3. Click **uploading an existing file** and drag in everything from the unzipped folder **except** the `.github` and `supabase` folders. Commit.
4. Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch **main**, folder **/ (root)** → Save.
5. After a minute your app is at `https://YOUR-GITHUB-NAME.github.io/recipes/`.

It runs in **demo mode** now (saved on that one device only). Have a play.

## 2. Create the Supabase project

1. Sign up at **supabase.com** (free plan) → **New project**.
2. Name: `family-recipes`, set a strong database password (save it in your password manager), Region: **East US** → Create.

## 3. Create the database

1. Left menu **SQL Editor** → **New query**.
2. Open `supabase/schema.sql` in Notepad, copy all of it, paste, click **Run**. You should see "Success".

This creates the recipe, meal-plan and shopping-list tables, the photo store, and the security rules (only signed-in family can see or change anything).

## 4. Family logins + connect the app

**Logins**
1. **Authentication → Users → Add user → Create new user.** Add one per family member (or one shared family login). Tick **Auto Confirm User**.
2. **Authentication → Sign In / Providers** (or **Settings**) → turn **off "Allow new users to sign up"**. Now only people you add can get in.

**Connect**
1. **Project Settings → API Keys** (or **Data API**). Copy the **Project URL** and the **publishable** key (older projects call it **anon public**).
2. On GitHub, open `config.js` → ✏️ edit → paste them in:
   ```js
   SUPABASE_URL: "https://xxxx.supabase.co",
   SUPABASE_ANON_KEY: "sb_publishable_..."
   ```
   Commit. Reload the app — you'll get a sign-in screen.

> These two values are meant to be public (they're in every Supabase web app). Never put the **secret / service_role** key in `config.js`.

## 5. Switch on smart import

Recipe websites import for free without this step. This step adds Instagram, TikTok, YouTube, Facebook, pasted text and photos of recipes.

**Get a Claude API key**
1. Sign up at **platform.claude.com** (the Claude Console) → **Billing** → add a small prepaid credit (e.g. $5 lasts thousands of imports).
2. Set a **monthly spend limit** (Billing → Limits) for peace of mind.
3. **API Keys → Create key** → copy it.

**Deploy the import function**
1. In Supabase: **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly `import-recipe`.
3. Delete the sample code, paste the whole of `supabase/functions/import-recipe/index.ts`, **Deploy**.
4. Open the function's **Details/Settings** → turn **off "Verify JWT"** (the function checks the family login itself) → Save.
5. **Edge Functions → Secrets** → add `ANTHROPIC_API_KEY` = your key → Save.

Test: in the app tap **+** → paste any recipe link → **Import**.

## 6. Keep it awake

Free Supabase projects pause after 7 days with no use. This GitHub job pings it twice a week.

1. GitHub repo → **Add file → Create new file** → name: `.github/workflows/keep-alive.yml` → paste the contents of that file from the zip → Commit.
2. Repo **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `SUPABASE_URL` = your Project URL
   - `SUPABASE_ANON_KEY` = your publishable key
3. **Actions** tab → **Keep Supabase awake** → **Run workflow** once to check it goes green.

> GitHub switches off scheduled jobs in repos with no changes for 60 days and emails you first — click the link in that email to keep it on. (If the family opens the app every week, it stays awake anyway.)

## 7. iPhone & iPad

**Add the app to the Home Screen** (each family member)
1. Open your app link in **Safari** → Share ⬆️ → **Add to Home Screen** → sign in.

**"Save Recipe" in the Share sheet** (import straight from Instagram, TikTok, Safari…)
1. **Shortcuts** app → **+** → name it **Save Recipe**.
2. Tap ⓘ → turn on **Show in Share Sheet**. Set it to receive **URLs** and **Text**.
3. Add action **URL Encode** (input: *Shortcut Input*).
4. Add action **Text**:
   `https://YOUR-GITHUB-NAME.github.io/recipes/?import=` then insert the **URL Encoded Text** variable right after `=`.
5. Add action **Open URLs** (input: the Text).

Now in Instagram/TikTok/Safari: **Share → Save Recipe**. It opens in Safari and imports. (iOS opens shortcuts in Safari rather than the Home Screen app, so sign in once in Safari too.) In Instagram use **Share → More** if Save Recipe isn't shown.

---

## Using it

- **Recipes** — Name, Photo, Ingredients, Method, Extra notes. Tap +/− on *Serves* to scale amounts.
- **🛒 on a recipe** — adds its ingredients; untick what you already have.
- **Plan** — tap *+ add* on any meal; **Make shopping list for this week** combines everything (2 onions + 1 onion = 3 onions).
- **Shopping** — tick as you shop; it updates live on everyone's phone. **Share list** texts it to someone.
- Imports can't read recipes that are only *spoken* in a video — type those in.

## Troubleshooting

| Problem | Fix |
|---|---|
| Still says "Demo mode" | `config.js` values not saved, or browser cached the old one — reload twice |
| "Invalid login credentials" | Check the user exists in Authentication → Users and is confirmed |
| Import says "smart import isn't switched on" | Step 5 secret missing or misspelled (`ANTHROPIC_API_KEY`) |
| Import error 401 from function | "Verify JWT" still on (step 5.4) |
| A site "blocked the import" | Copy the recipe text → **Paste text** tab |
| App not loading after a week | Project paused — Supabase dashboard → **Restore**; then check step 6 |
