# finals-rs-api

A tiny hosted web API for THE FINALS ranked stats, built specifically to be
called from a **StreamElements custom command** — no Twitch bot account, no
OAuth token, no local machine, nothing to run yourself. The streamer adds
one command in a dashboard they already use, and it just works, forever.

It wraps the free community leaderboard API at
`api.the-finals-leaderboard.com` and returns plain text ready to post
straight into chat. The ranked season is auto-detected and re-checked every
6 hours, so it never needs manual updates.

## One-time deploy (about 5 minutes, all in the browser)

1. Go to [render.com](https://render.com) and sign up (free, no card needed).
2. Click **New +** → **Web Service**.
3. Connect this code — easiest way: create a free GitHub repo, upload these
   3 files (`server.js`, `package.json`, `.env.example`) to it, then pick
   that repo in Render.
4. Render auto-detects it as a Node app. Leave the defaults:
   - Build command: `npm install`
   - Start command: `npm start`
5. Under **Environment Variables**, add:
   - `STREAMER_EMBARK_ID` = the streamer's own Embark ID, e.g. `Nats#1234`
6. Click **Create Web Service**. Wait ~2 minutes for the first deploy.
7. Render gives you a URL like `https://finals-rs-api-xxxx.onrender.com` —
   copy it.

That's it. It's now live 24/7, no laptop required, and redeploys itself
automatically if it ever crashes.

> Free-tier note: Render's free web services spin down after 15 minutes of
> no traffic, and take a few seconds to wake up on the next request. For a
> Twitch chat command used a few times a stream this is barely noticeable.
> If it matters, Render's cheapest paid tier (~$7/mo) keeps it always warm.

## Add the command in StreamElements

In the StreamElements dashboard → **Chat Bot** → **Commands** → **Custom**,
add a new command:

- Command: `!rs`
- Response:
  ```
  ${urlfetch https://YOUR-RENDER-URL.onrender.com/rs?name=$(queryescape ${1:})}
  ```
  (replace `YOUR-RENDER-URL` with the URL from step 7 above)

Save it. Done — `!rs` is now live in chat.

## Usage in chat

```
!rs
```
With no name, replies with the streamer's own rank.

```
!rs Nats#1234
```
Full tag — fastest, always picks the right player.

```
!rs Nats
```
Partial name search:
- One match → replies with their stats.
- Multiple matches → lists up to 5 and asks for the full tag.
- No match → says so (typo, unranked, or outside top 10,000).

Example reply:
```
Nats#1234 is rank #482 [Diamond 2] with 24850 RS (+120).
```

## Notes

- This is a separate, simpler alternative to the standalone `finals-rs-bot`
  Node bot built earlier — that version needs a Twitch bot account, OAuth
  token, and a machine/host running `node index.js` directly. This API
  version needs none of that, since StreamElements is already the
  always-on bot; this just feeds it data.
- Built on the free, community-maintained leaderboard API by leonlarsson
  (https://github.com/leonlarsson/the-finals-api), not an official Embark
  Studios API. It could change or go down without notice.
- If `STREAMER_EMBARK_ID` is ever wrong or out of date, just update the
  environment variable in Render's dashboard — no redeploy needed, it picks
  it up automatically on the next request.
