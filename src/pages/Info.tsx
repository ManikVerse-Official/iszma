import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, HelpCircle, MessageCircle, Sparkles } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { Footer } from '../components/Footer';
import { Chatbot } from '../components/Chatbot';
import { IsZmaWatermarkBg } from '../components/brand/IsZmaWatermarkBg';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle } from '../services/seo';
import { ADMIN_WHATSAPP_DISPLAY, whatsappSupportUrl } from '../services/supportContact';

/**
 * The marketing pages whose URLs the sitemap advertises (/store, /blog, /faq,
 * /contact). They share one shell so every entry in the sitemap resolves to a
 * real, indexable page instead of a soft 404, and each carries its own title,
 * description and canonical URL.
 */

interface ShellProps {
  page: string;
  heading: string;
  intro: string;
  description: string;
  path: string;
  children: ReactNode;
}

const Shell: React.FC<ShellProps> = ({ page, heading, intro, description, path, children }) => {
  const [searchTerm, setSearchTerm] = useState('');

  usePageMeta({ title: pageTitle(page), description, path });

  return (
    <div className="relative isolate min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end">
      <IsZmaWatermarkBg />
      <Navbar searchTerm={searchTerm} setSearchTerm={setSearchTerm} />
      <main className="mx-auto max-w-3xl px-4 pb-12 pt-10 sm:px-6 sm:pt-16 lg:px-8">
        <header className="mb-8">
          <span className="mb-4 inline-flex items-center gap-2 rounded-full border border-neon-purple/30 bg-neon-purple/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-neon-purple">
            <Sparkles className="h-3 w-3" />
            isZma
          </span>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">{heading}</h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-400 sm:text-base">{intro}</p>
        </header>
        {children}
      </main>
      <Footer />
      <Chatbot />
    </div>
  );
};

interface CardProps {
  to: string;
  title: string;
  body: string;
  cta?: string;
}

const Card: React.FC<CardProps> = ({ to, title, body, cta = 'Open' }) => (
  <Link
    to={to}
    className="group flex flex-col justify-between rounded-2xl border border-neon-purple/20 bg-bg-dark-end/70 p-5 transition-colors hover:border-neon-purple/50 hover:bg-neon-purple/5"
  >
    <div>
      <h2 className="text-base font-semibold text-white">{title}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-400">{body}</p>
    </div>
    <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-neon-purple">
      {cta}
      <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
    </span>
  </Link>
);

const STORE_ITEMS = [
  {
    to: '/section/greetings',
    title: 'Digital Greetings',
    body: 'Animated greeting cards for birthdays, anniversaries, weddings and festivals. Every card gets a private link that stays live for 48 hours.',
  },
  {
    to: '/section/reportcard-studio',
    title: 'ReportCard Studio',
    body: 'Turn an Excel mark sheet into print-ready school report cards. Files are processed in your browser, so student data never leaves your device.',
  },
  {
    to: '/game-zone',
    title: 'Game Zone — Pair-3Balls',
    body: 'Play against the computer offline, with a friend on one device, in a private room, or in a world match.',
  },
];

/** /store — what is actually on sale in the mall right now. */
export const Store: React.FC = () => (
  <Shell
    page="Store"
    heading="The isZma Store"
    intro="Everything in the mall is digital and delivered the moment you pay — no shipping, no waiting."
    description="Browse the isZma store: animated digital greeting cards, ReportCard Studio report card tools and the Pair-3Balls game zone."
    path="/store"
  >
    <div className="grid gap-4 sm:grid-cols-2">
      {STORE_ITEMS.map((item) => (
        <Card key={item.to} {...item} cta="Open section" />
      ))}
    </div>
    <p className="mt-6 text-xs leading-relaxed text-gray-500">
      Prices are shown in your local currency — INR for visitors in India, USD elsewhere — and are
      updated by the store admin in real time. Payments are processed by Razorpay, PayPal and Stripe.
    </p>
  </Shell>
);

const JOURNAL_ITEMS = [
  {
    to: '/section/greetings',
    title: 'How a digital greeting card works',
    body: 'Pick a theme, add a name and a message, then share one private link. The card stays live for 48 hours and can be managed or deleted by the sender.',
  },
  {
    to: '/section/reportcard-studio',
    title: 'From Excel to printed report cards',
    body: 'A walkthrough of the Studio workflow: import a mark sheet, map the columns, check the holistic notes, then export print-ready cards.',
  },
  {
    to: '/game-zone',
    title: 'Pair-3Balls: offline, private room or world match',
    body: 'The three ways to play, what works without a connection, and how invite links put two players in the same room.',
  },
];

/** /blog — guides that point at the live sections. */
export const Blog: React.FC = () => (
  <Shell
    page="Journal"
    heading="The isZma Journal"
    intro="Short guides to getting the most out of the mall, written as each section ships."
    description="Guides and notes from isZma, The Digital Mall — greeting cards, ReportCard Studio and the Game Zone."
    path="/blog"
  >
    <div className="grid gap-4">
      {JOURNAL_ITEMS.map((item) => (
        <Card key={item.to} {...item} cta="Read the guide" />
      ))}
    </div>
    <p className="mt-6 text-xs leading-relaxed text-gray-500">
      Longer articles are added here as new sections open in the mall.
    </p>
  </Shell>
);

const FAQ_ITEMS = [
  {
    q: 'What is isZma?',
    a: 'isZma is The Digital Mall — a home for digital products and tools, including animated greeting cards, ReportCard Studio for school report cards, and the Pair-3Balls game zone.',
  },
  {
    q: 'How long does a greeting card stay live?',
    a: 'Each card is shared as a private link that stays live for 48 hours. After that it expires automatically and is removed from our systems.',
  },
  {
    q: 'Can I send a card on WhatsApp?',
    a: 'Yes. After creating a card you get a shareable link, which works in WhatsApp, SMS, email or anywhere else you can paste a link.',
  },
  {
    q: 'Which currency will I be charged in?',
    a: 'Visitors in India see prices in INR and pay through Razorpay. Visitors elsewhere see USD prices and can pay with PayPal or a card through Stripe.',
  },
  {
    q: 'Does ReportCard Studio upload my student data?',
    a: 'No. The mark sheet is processed in your browser, and generated PDFs and ZIP files are created on your device. Files are not uploaded to our servers.',
  },
  {
    q: 'Are purchases refundable?',
    a: 'Greeting cards and digital downloads are delivered instantly and cannot be returned, so they are generally non-refundable. If a payment succeeded but the product was not delivered, contact us and we will resolve it.',
  },
  {
    q: 'How do I reach a human?',
    a: 'Message the admin team on WhatsApp from the contact page. For anything payment-related, keep the payment id (pay_… or FREE-…) handy so the lookup is instant.',
  },
];

/** /faq — questions the support channel actually answers. */
export const Faq: React.FC = () => (
  <Shell
    page="FAQ"
    heading="Frequently asked questions"
    intro="Short answers about cards, payments, report cards and the game zone."
    description="Answers to common isZma questions about digital greeting cards, pricing and currencies, ReportCard Studio privacy and refunds."
    path="/faq"
  >
    <div className="space-y-3">
      {FAQ_ITEMS.map((item) => (
        <details
          key={item.q}
          className="group rounded-2xl border border-neon-purple/20 bg-bg-dark-end/70 p-5 open:border-neon-purple/40"
        >
          <summary className="flex cursor-pointer items-center justify-between gap-3 text-sm font-semibold text-white marker:content-none">
            {item.q}
            <HelpCircle className="h-4 w-4 shrink-0 text-neon-purple" />
          </summary>
          <p className="mt-3 text-sm leading-relaxed text-gray-400">{item.a}</p>
        </details>
      ))}
    </div>
    <Link
      to="/contact"
      className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-neon-purple hover:text-purple-400"
    >
      Still stuck? Contact us <ArrowRight className="h-4 w-4" />
    </Link>
  </Shell>
);

/** /contact — the one support channel the team actually staffs. */
export const Contact: React.FC = () => (
  <Shell
    page="Contact"
    heading="Contact isZma"
    intro="Questions, payment problems or feedback about a card — the admin team is one message away."
    description="Contact isZma support on WhatsApp for help with greeting cards, payments, ReportCard Studio and the Game Zone."
    path="/contact"
  >
    <section className="rounded-2xl border border-neon-purple/20 bg-bg-dark-end/70 p-5 sm:p-6">
      <h2 className="text-base font-semibold text-white">WhatsApp support</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-gray-400">
        Messages are answered by the isZma admin team on {ADMIN_WHATSAPP_DISPLAY}. You can review and
        edit your message in WhatsApp before sending it.
      </p>
      <a
        href={whatsappSupportUrl()}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-4 inline-flex items-center gap-2 rounded-xl bg-neon-purple px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-purple-600"
      >
        <MessageCircle className="h-4 w-4" />
        Chat on WhatsApp
      </a>
    </section>

    <section className="mt-4 rounded-2xl border border-neon-purple/20 bg-bg-dark-end/70 p-5 sm:p-6">
      <h2 className="text-base font-semibold text-white">Before you write in</h2>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-gray-400">
        <li>
          Payment questions are resolved fastest with the payment id (pay_… or FREE-…) and the email
          used at checkout.
        </li>
        <li>
          The <Link to="/faq" className="text-neon-purple hover:text-purple-400">FAQ</Link> already
          covers card lifetime, currencies and refunds.
        </li>
        <li>
          Legal wording lives in the{' '}
          <Link to="/terms" className="text-neon-purple hover:text-purple-400">Terms</Link> and{' '}
          <Link to="/privacy" className="text-neon-purple hover:text-purple-400">Privacy Policy</Link>.
        </li>
      </ul>
    </section>
  </Shell>
);
