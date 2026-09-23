# Our home: setup guide

This gets your home list online at its own web address, with sign-in and automatic photos and prices. It takes about 30 to 45 minutes, and everything used here has a free plan. You won't need to write any code.

You'll create three free accounts:

- **Supabase** stores your list and handles signing in.
- **GitHub** holds the code.
- **Vercel** puts the site online.

Before you start, unzip `our-home.zip` so you have an `our-home` folder.

---

## Step 1: Set up the database (Supabase)

1. Go to **supabase.com** and sign up.
2. Click **New project**. Name it `our-home`, create a database password (save it somewhere, though you won't need it again here), pick the **London** region, and click **Create**. Wait a minute or two while it sets up.
3. In the left sidebar, open **SQL Editor** and click **New query**.
4. Open the file `supabase/schema.sql` from your folder in any text editor (TextEdit or Notepad is fine). Copy everything in it, paste it into Supabase and click **Run**. You should see "Success".
5. In the left sidebar, open **Project Settings**, then **API** (on newer screens, this is called **Data API** and **API Keys**). Keep this tab open. You'll need two things from it in Step 3:
   - the **Project URL**, which looks like `https://abcdefg.supabase.co`
   - the **anon public** key (on newer screens, the **publishable** key), a long line of text

## Step 2: Put the code on GitHub

1. Go to **github.com** and sign up.
2. Click the **+** in the top right, then **New repository**. Name it `our-home`, choose **Private**, and click **Create repository**.
3. On the next page, click the link that says **uploading an existing file**.
4. Open your `our-home` folder, select **everything inside it** (the files and folders, not the folder itself), and drag them onto the page.
   - On a Mac, press Cmd+Shift+. in the folder window to see the hidden `.gitignore` file. It's fine if you skip it.
5. Click **Commit changes**.

## Step 3: Put the site online (Vercel)

1. Go to **vercel.com** and click **Sign up**. Choose **Continue with GitHub**.
2. Click **Add New…**, then **Project**, and **Import** your `our-home` repository.
3. Open **Environment Variables** and add these two, copying the values from the Supabase tab you left open:

   | Name | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | your Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your anon / publishable key |

4. Click **Deploy**. After a minute or two you'll get a web address like `our-home-abc.vercel.app`. Copy it.

## Step 4: Connect sign-in to your new address

1. Back in Supabase, open **Authentication**, then **URL Configuration**.
2. Paste your Vercel address (starting with `https://`) into **Site URL**.
3. Under **Redirect URLs**, click **Add URL** and paste the same address again. Click **Save**.

## Step 5: Start using it

1. Open your Vercel address and enter your email. Tap the sign-in link that arrives, **on the same device**.
2. Tap **Start our home**. You'll get a Living room, a Kitchen and a Bedroom to begin with.
3. Copy a product link from any shop and paste it into the box. The photo, name and price appear in a few seconds, sorted into the right section.
4. To invite your partner, open **Settings** and send them the six-letter invite code. They sign in with their own email, then choose **I have an invite code**.

**To put it on your phone's home screen:**

- **iPhone:** open the site in Safari, tap **Share**, then **Add to Home Screen**.
- **Android:** open the site in Chrome, tap **⋮**, then **Add to Home screen**.

---

## Using it

- **Add:** paste one link, or several at once (for example, straight from your notes). Each one is added separately.
- **Include or set aside:** tap the round tick on a photo to leave that piece out of the total, or put it back in.
- **Edit:** tap a piece's name to change its price, quantity, room or section, add notes, or remove it.
- **Remove:** it happens straight away, and a message appears with **Undo** for a few seconds in case you tapped it by mistake.
- **Rooms:** tap **+ Room** to add one. Use **Room options** to rename or remove a room.
- **Refresh photo and price:** do this from a piece's edit screen if the shop changes its price.

## Good to know

- **Most shops work automatically.** A few, Amazon especially, block this kind of reading or hide their prices. When that happens, the piece still appears, and you tap **Add price** to type it in.
- **Photos load straight from the shop's website.** If a shop later removes a product, its photo may disappear too.
- **Supabase's free plan pauses a project after about a week with no visits.** If that happens, log in to supabase.com and click **Restore**. Nothing is lost.
- **Sign-in emails on the free plan are limited to a few per hour.** That's plenty for two people.

## If something goes wrong

- **Sign-in link opens a blank page or an error:** recheck Step 4. The Site URL and Redirect URL must exactly match your Vercel address.
- **"Couldn't reach that page" on every link:** in Vercel, open **Settings**, then **Environment Variables**, and check both values have no extra spaces. After fixing them, go to **Deployments**, click **⋯** on the newest one and choose **Redeploy**.
- **Anything else:** copy the error message and paste it to Claude.
