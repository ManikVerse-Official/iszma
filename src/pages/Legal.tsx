import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ShieldCheck, ScrollText } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { Footer } from '../components/Footer';
import { IsZmaWatermarkBg } from '../components/brand/IsZmaWatermarkBg';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle } from '../services/seo';

type LegalKind = 'terms' | 'privacy';

interface Section {
  heading: string;
  body: string[];
}

const LAST_UPDATED = 'October 2026';

const TERMS: Section[] = [
  {
    heading: '1. Acceptance of these terms',
    body: [
      'By accessing or using isZma (the "Service", formerly Ishmaverse), including the Digital Greetings store and ReportCard Studio, you agree to be bound by these Terms & Conditions. If you do not agree, please do not use the Service.',
    ],
  },
  {
    heading: '2. What isZma provides',
    body: [
      'isZma is a digital mall offering animated greeting cards, downloadable digital products and ReportCard Studio report-card generation. Greeting cards are shared as temporary links that stay live for 48 hours, after which they expire automatically and are removed from our systems.',
    ],
  },
  {
    heading: '3. Accounts, pricing and payments',
    body: [
      'Prices are shown in your local currency (INR for visitors in India, USD elsewhere) and may be updated at any time. Payments are processed securely by our payment partners (Razorpay, PayPal and Stripe). We never store your full card or banking credentials.',
      'Certain plans and services include a limited number of free uses. Once the free allowance is used, continued access requires a paid plan. Report-card subscription tiers and their prices are displayed on the relevant plan screen before you pay.',
    ],
  },
  {
    heading: '4. Fair use and email/IP limits',
    body: [
      'To keep the Service fair for everyone, free trials and promotional uses are limited per email address and per network (IP) address. Creating multiple accounts to obtain additional free usage is not permitted and may result in suspension. We process only the minimum technical data needed to apply these limits.',
    ],
  },
  {
    heading: '5. Your content',
    body: [
      'You are responsible for the content you upload or enter, including names, messages and photographs. You confirm that you have the right to use any photo or data you upload, and that your content does not infringe anyone else\u2019s rights or violate any law.',
    ],
  },
  {
    heading: '6. ReportCard Studio',
    body: [
      'ReportCard Studio generates report cards from files you provide. Files are processed in your browser and are not uploaded to our servers. You are responsible for the accuracy of the data you import and for complying with your institution\u2019s rules on student records.',
    ],
  },
  {
    heading: '7. Refunds',
    body: [
      'Because greeting-card links and digital downloads are delivered instantly and cannot be returned, purchases are generally non-refundable once the card or file has been generated. If a payment succeeded but the product was not delivered, contact us and we will resolve it.',
    ],
  },
  {
    heading: '8. Limitation of liability',
    body: [
      'The Service is provided "as is". To the maximum extent permitted by law, isZma is not liable for any indirect or consequential loss arising from your use of the Service. Nothing in these terms limits rights that cannot be excluded by law.',
    ],
  },
  {
    heading: '9. Changes and contact',
    body: [
      'We may update these terms from time to time; the latest version always applies. For any questions about these terms, please reach us through the contact details on our website.',
    ],
  },
];

const PRIVACY: Section[] = [
  {
    heading: '1. Information we collect',
    body: [
      'We collect the information you give us (such as the names and messages you enter on a card, and your email address at checkout) and limited technical information needed to run the Service, such as your IP address and browser type.',
    ],
  },
  {
    heading: '2. How we use your information',
    body: [
      'Your information is used to create and deliver your order, to send you receipts and service emails, to prevent abuse of free trials and promotions, and to improve the Service.',
    ],
  },
  {
    heading: '3. Photos and card content',
    body: [
      'Greeting cards, including any photo you add, stay live for 48 hours and are then automatically removed. ReportCard Studio files are processed locally in your browser and are never uploaded to our servers.',
    ],
  },
  {
    heading: '4. Sharing',
    body: [
      'We share data only with the service providers required to operate the Service, such as our payment processors, email provider and hosting provider. We do not sell your personal information.',
    ],
  },
  {
    heading: '5. Your choices',
    body: [
      'You can request access to, correction of, or deletion of your personal data by contacting us. Senders can also delete a card early using the private management link shown after purchase.',
    ],
  },
];

export const Legal: React.FC<{ kind: LegalKind }> = ({ kind }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const sections = kind === 'terms' ? TERMS : PRIVACY;
  const title = kind === 'terms' ? 'Terms & Conditions' : 'Privacy Policy';

  usePageMeta({
    title: pageTitle(title),
    description:
      kind === 'terms'
        ? 'The terms that apply to isZma, The Digital Mall, including digital greeting cards and ReportCard Studio.'
        : 'How isZma handles your data for greeting cards, ReportCard Studio, payments and support.',
    path: kind === 'terms' ? '/terms' : '/privacy',
  });

  return (
    <div className="relative isolate min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end">
      <IsZmaWatermarkBg />
      <Navbar searchTerm={searchTerm} setSearchTerm={setSearchTerm} />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-10 sm:pt-16 pb-12">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to home
        </Link>

        <header className="mb-8">
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neon-purple bg-neon-purple/10 border border-neon-purple/30 rounded-full px-3 py-1 mb-4">
            {kind === 'terms' ? <ScrollText className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
            Legal
          </span>
          <h1 className="text-3xl sm:text-4xl font-bold text-white">{title}</h1>
          <p className="text-gray-400 text-sm mt-2">Last updated: {LAST_UPDATED}</p>
        </header>

        <div className="space-y-6">
          {sections.map((section) => (
            <section
              key={section.heading}
              className="bg-bg-dark-end/70 border border-neon-purple/20 rounded-2xl p-5 sm:p-6"
            >
              <h2 className="text-lg font-semibold text-white mb-2">{section.heading}</h2>
              {section.body.map((paragraph, i) => (
                <p key={i} className="text-sm text-gray-300 leading-relaxed mb-2 last:mb-0">
                  {paragraph}
                </p>
              ))}
            </section>
          ))}
        </div>

        <p className="text-sm text-gray-400 mt-8">
          See also{' '}
          <Link
            to={kind === 'terms' ? '/privacy' : '/terms'}
            className="text-neon-purple hover:underline"
          >
            {kind === 'terms' ? 'our Privacy Policy' : 'our Terms & Conditions'}
          </Link>
          .
        </p>
      </main>

      <Footer />
    </div>
  );
};
