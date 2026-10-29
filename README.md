# isZma — The Digital Mall

A production-ready, modular digital mall built with React, TypeScript, Vite, Tailwind CSS, Supabase, and Firebase. It hosts digital greeting cards, ReportCard Studio, digital products and the Game Zone.

## Features

- **Single Source of Truth Branding**: Dynamic global state that updates everywhere in real-time via Supabase
- **Modular Architecture**: Clean folder structure with separate components, pages, services, and context
- **Premium Cyberpunk UI**: Dark theme with neon purple accents
- **Comprehensive Admin Dashboard**: Control branding, sections, gifts, configuration, sales, and integrations
- **Floating Chatbot**: Scripted receptionist bot in bottom right
- **Cloudflare Pages Ready**: Optimized for deployment to Cloudflare Pages

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS
- **Database & Auth**: Supabase (PostgreSQL + Realtime)
- **Chat & Logs**: Firebase Firestore
- **Icons**: Lucide React
- **Routing**: React Router DOM

## Folder Structure

```
ishmaverse/
├── src/
│   ├── components/       # Reusable UI components
│   │   ├── Navbar.tsx
│   │   ├── Footer.tsx
│   │   ├── Hero.tsx
│   │   ├── Categories.tsx
│   │   └── Chatbot.tsx
│   ├── pages/            # Page components
│   │   ├── Home.tsx
│   │   └── Admin.tsx
│   ├── services/         # API and service clients
│   │   ├── supabase.ts
│   │   └── firebase.ts
│   ├── context/          # React Context providers
│   │   └── BrandContext.tsx
│   ├── types/            # TypeScript type definitions
│   │   └── index.ts
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── .env.example
```

## Setup Instructions

1. **Clone the repository**
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Copy environment variables**:
   ```bash
   cp .env.example .env
   ```
4. **Fill in your credentials** in the `.env` file:
   - Supabase URL and anon key
   - Firebase config
   - Payment gateway keys (Razorpay, PayPal)
5. **Start the development server**:
   ```bash
   npm run dev
   ```

## Supabase Setup

Create a `site_settings` table in your Supabase project:

```sql
CREATE TABLE site_settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  site_name TEXT DEFAULT 'isZma',
  brand_tagline TEXT DEFAULT 'The Digital Mall',
  logo_url TEXT,
  primary_color TEXT DEFAULT '#8b5cf6',
  secondary_color TEXT DEFAULT '#1a0b2e',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO site_settings (site_name, brand_tagline) VALUES ('isZma', 'The Digital Mall');
```

Enable Realtime for the `site_settings` table to get live updates.

### Greeting cards table

Digital Greetings cards create their own rows and self-destruct after 48 hours.

```sql
CREATE TABLE greeting_cards (
  id TEXT PRIMARY KEY,
  sender_name TEXT NOT NULL,
  receiver_name TEXT NOT NULL,
  message TEXT NOT NULL,
  theme TEXT NOT NULL,
  external_image_url TEXT,
  amount NUMERIC DEFAULT 0,
  paid BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '48 hours'
);

ALTER TABLE greeting_cards ENABLE ROW LEVEL SECURITY;

-- Anyone with the link can read a card, anyone can create one
CREATE POLICY "greeting cards are public" ON greeting_cards FOR SELECT USING (true);
CREATE POLICY "greeting cards can be created" ON greeting_cards FOR INSERT WITH CHECK (true);
```

If Supabase is not configured (or the table does not exist yet), cards fall back to
`localStorage` so the flow still works end to end during development.

## Digital Greetings section

- Home lists mall sections; only **Digital Greetings** is stocked, the rest show as *Coming soon*.
- Inside the section, visitors search or filter by category (Romantic, Birthday, Marriage &
  Anniversary, Festivals, Functions & Events, Family & Friends).
- Themes are priced from ₹47 (Basic) to ₹157 (Elite).
- The shareable link is generated **only after payment**. India pays with Razorpay (UPI, cards,
  netbanking, wallets), the rest of the world with PayPal.
- Admin sessions (`/admin`) generate any card for free.
- Every card expires after 48 hours; the viewer shows a live countdown and a graceful
  "this moment has passed" screen once it does.
- Set `VITE_GREETING_DOMAIN` to serve each card from its own subdomain
  (`https://<card-id>.your-domain.com`). Without it cards live at `/greet/<card-id>`.

## Deployment

The project is ready to deploy to Cloudflare Pages:
1. Connect your GitHub repository to Cloudflare Pages
2. Set build command to `npm run build`
3. Set output directory to `dist`
4. Add environment variables in Cloudflare Pages settings
