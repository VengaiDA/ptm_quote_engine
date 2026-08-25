# PTM Quote Engine

`index.html` is a standalone, client-side quotation calculator for PTM Exclusive Accommodation. It has no backend, database, account, analytics, or build step.

## Run locally

Open `index.html` in a modern browser. The Tailwind CSS and Lucide icon CDNs need an internet connection for their presentation assets; all quotation data and calculations stay in the browser.

## Deploy to GitHub Pages

1. In the repository, open **Settings → Pages**.
2. Select **Deploy from a branch**, then select `main` and the `/ (root)` folder.
3. Save. GitHub will provide the public URL shortly afterwards.

Expected URL: `https://vengaida.github.io/ptm_quote_engine/`

## Deploy to Cloudflare Pages

1. Create a new **Pages** project and connect the repository that contains `index.html`.
2. Choose the production branch.
3. Select the **Static HTML** setup. Use `exit 0` as the build command and `.` as the build output directory, because `index.html` is already in the repository root.
4. Deploy.

## Update PTM commercial rules

At the top of the JavaScript in `index.html`, edit the clearly labelled `CONFIG` object to change the nightly rate, discount tiers, optional-charge defaults, or quote validity period. The calculation logic reads from this object automatically.
