import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Upload,
  Loader2,
  ArrowRight,
  Copy,
  Check,
  Clock,
  ShieldCheck,
  ExternalLink,
  Eye,
  RefreshCw,
  Download,
  Mail,
  Crop,
} from 'lucide-react';
import { GreetingTheme, PaymentProof, Product } from '../types';
import { useGreeting } from '../context/GreetingContext';
import { CheckoutModal } from './CheckoutModal';
import { GreetingCardVisual } from './GreetingCardVisual';
import { GreetingPreviewModal } from './GreetingPreviewModal';
import { PhotoFrame } from './PhotoFrame';
import { ImageCropper, type CropResult } from './ImageCropper';
import { greetingFonts, getFontById, DEFAULT_FONT_ID } from '../data/fonts';
import { themePriceForRegion } from '../services/catalog';
import { useCurrency } from '../context/CurrencyContext';
import {
  buildGreetingUrl,
  buildManageUrl,
  createGreetingCard,
  createFreeGreetingCard,
  fetchReceipt,
  formatCountdown,
  isPaymentDemoMode,
} from '../services/greetingService';
import { clearPendingGreeting, type PendingGreeting } from '../services/pendingCheckout';
import {
  uploadGreetingAudio,
  isMp3File,
  formatBytes,
  MAX_GREETING_AUDIO_BYTES,
} from '../services/greetingAudio';
import { sendPurchaseEmail } from '../services/notify';
import { uploadCardImageUrl } from '../services/imageUpload';
import { TIER_LABELS, TIER_TAGLINES } from '../data/greetingThemes';
import {
  AUDIO_TRACKS_BY_CATEGORY,
  DEFAULT_AUDIO_TRACKS,
  isAudioTier,
  tierAudioLabel,
} from '../data/audio';
import type { AudioTier } from '../data/audio';

type Step = 'details' | 'done';

/** Quick two-colour gradient presets for the background pickers. */
const GRADIENT_SWATCHES: { label: string; start: string; end: string }[] = [
  { label: 'Sunset', start: '#f97316', end: '#db2777' },
  { label: 'Ocean', start: '#0ea5e9', end: '#4f46e5' },
  { label: 'Aurora', start: '#22d3ee', end: '#7c3aed' },
  { label: 'Rose', start: '#fb7185', end: '#a855f7' },
  { label: 'Gold', start: '#f59e0b', end: '#b45309' },
  { label: 'Emerald', start: '#10b981', end: '#0f766e' },
  { label: 'Midnight', start: '#0f172a', end: '#6d28d9' },
  { label: 'Blush', start: '#f9a8d4', end: '#c084fc' },
];

interface ThemeOrderModalProps {
  theme: GreetingTheme | null;
  isOpen: boolean;
  onClose: () => void;
}

export const ThemeOrderModal: React.FC<ThemeOrderModalProps> = ({ theme, isOpen, onClose }) => {
  const { isAdmin, customerName, customerEmail, setCustomerName, setCustomerEmail } = useGreeting();

  const [step, setStep] = useState<Step>('details');
  const [details, setDetails] = useState({ sender: '', receiver: '', message: '' });
  const [fontId, setFontId] = useState<string>(DEFAULT_FONT_ID);
  // Sender colour overrides — empty means "use the theme's own colours".
  const [titleColor, setTitleColor] = useState('');
  const [messageColor, setMessageColor] = useState('');
  const [signatureColor, setSignatureColor] = useState('');
  const [textColor, setTextColor] = useState('');
  const [bgGradientStart, setBgGradientStart] = useState('');
  const [bgGradientEnd, setBgGradientEnd] = useState('');
  const [bgGradientAngle, setBgGradientAngle] = useState(135);
  const [title, setTitle] = useState('');
  const [eyebrow, setEyebrow] = useState('');
  const [signoff, setSignoff] = useState('');
  const [selectedAudioTrack, setSelectedAudioTrack] = useState<string | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  // The untouched upload, kept so the sender can re-open the cropper any time.
  const [originalImageSrc, setOriginalImageSrc] = useState<string | null>(null);
  // Non-null while the interactive crop/pan tool is open.
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  // Custom background music (Premium & Elite): local file, preview URL and the
  // hosted URL returned once the upload finishes.
  const [customAudioFile, setCustomAudioFile] = useState<File | null>(null);
  const [customAudioPreview, setCustomAudioPreview] = useState<string | null>(null);
  const [customAudioTrack, setCustomAudioTrack] = useState('');
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);
  const [audioError, setAudioError] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [cardLink, setCardLink] = useState('');
  const [managementToken, setManagementToken] = useState('');
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [receiptHtml, setReceiptHtml] = useState('');
  const [receiptNumber, setReceiptNumber] = useState('');
  const [receiptEmailed, setReceiptEmailed] = useState(false);
  const [createError, setCreateError] = useState('');
  // False for a reached limit: retrying the same request can never succeed.
  const [createErrorRetryable, setCreateErrorRetryable] = useState(true);
  const [lastPayment, setLastPayment] = useState<PaymentProof | null>(null);
  // Free cards need an email because the limit is per email address.
  const [freeEmail, setFreeEmail] = useState('');
  const [now, setNow] = useState(() => new Date());

  // Visitor's currency — geo-detected by default, overridable from the navbar.
  // Price and gateway always read this single source of truth.
  const { isIndia: isIndiaRegion, symbol: currencySymbol } = useCurrency();

  const checkoutProduct: Product | null = useMemo(() => {
    if (!theme) return null;
    // Admin-configured USD price (never a converted INR value) for foreign buyers.
    const price = themePriceForRegion(theme, isIndiaRegion);

    return {
      id: `greeting-${theme.id}`,
      category_id: 'greetings',
      name: `${theme.name} — Digital Greeting Card`,
      description: theme.tagline,
      price,
      price_inr: theme.price,
      price_usd: theme.price_usd,
      currency: isIndiaRegion ? 'INR' : 'USD',
      image_url: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }, [theme, isIndiaRegion]);

  // Reset everything whenever a new theme is opened
  useEffect(() => {
    if (isOpen) {
      setStep('details');
      setDetails({ sender: customerName, receiver: '', message: '' });
      setFontId(theme?.design.defaultFont ?? DEFAULT_FONT_ID);
      setTitleColor('');
      setMessageColor('');
      setSignatureColor('');
      setTextColor('');
      setBgGradientStart('');
      setBgGradientEnd('');
      setBgGradientAngle(135);
      setTitle('');
      setEyebrow('');
      setSignoff('');
      setSelectedAudioTrack(null);
      setImageFile(null);
      setImagePreview(null);
      setOriginalImageSrc(null);
      setCropSrc(null);
      setCustomAudioFile(null);
      setCustomAudioPreview(null);
      setCustomAudioTrack('');
      setIsUploadingAudio(false);
      setAudioError('');
      setIsPreviewOpen(false);
      setIsPaymentOpen(false);
      setCardLink('');
      setManagementToken('');
      setExpiresAt(null);
      setCopied(false);
      setReceiptHtml('');
      setReceiptNumber('');
      setReceiptEmailed(false);
      setCreateError('');
      setCreateErrorRetryable(true);
      setLastPayment(null);
      setFreeEmail(customerEmail || '');
      setIsGenerating(false);
    }
  }, [isOpen, theme?.id]);

  // Live countdown for the generated link
  useEffect(() => {
    if (step !== 'done') return;
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, [step]);

  if (!theme) return null;

  const remainingMs = expiresAt ? Math.max(0, expiresAt.getTime() - now.getTime()) : 0;
  const displayPrice = checkoutProduct?.price ?? theme.price;
  /*
   * A free card is one whose payable amount is 0. Checking the regional price as
   * well as the INR price means a card can never reach a gateway with a ₹0 / $0
   * total (which is exactly how a "Pay ₹0 with Razorpay" button appeared).
   */
  const isFreeTheme = theme.price === 0 || !(Number(displayPrice) > 0);
  // Admins generate cards free of charge and must not use up a free-card slot.
  const usesFreeCardFlow = isFreeTheme && !isAdmin;
  const isFreeEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(freeEmail.trim());

  const isDetailsValid =
    details.sender.trim().length > 0 &&
    details.receiver.trim().length > 0 &&
    details.message.trim().length > 0 &&
    (!usesFreeCardFlow || isFreeEmailValid);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      // Always send the raw upload through the crop/pan tool first so faces are
      // never cut off by the card's fixed aspect ratio.
      setOriginalImageSrc(dataUrl);
      setCropSrc(dataUrl);
    };
    reader.readAsDataURL(file);
    // Allow re-selecting the same file (re-opens the cropper).
    e.target.value = '';
  };

  /** Applies the sender's chosen crop as both the preview and the upload. */
  const handleCropApply = ({ dataUrl, file }: CropResult) => {
    setImageFile(file);
    setImagePreview(dataUrl);
    setCropSrc(null);
  };

  /** Clears the stock selection and any uploaded custom song. */
  const clearCustomAudio = () => {
    setSelectedAudioTrack(null);
    setCustomAudioFile(null);
    setCustomAudioTrack('');
    setAudioError('');
    setCustomAudioPreview((prev) => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
      return null;
    });
  };

  /**
   * Handles the sender's own MP3 (Premium & Elite). The file is validated and
   * uploaded right away, so by the time they reach checkout the hosted URL is
   * ready and nothing large sits in the payment redirect payload.
   */
  const handleCustomAudioChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setAudioError('');

    if (!isMp3File(file)) {
      setAudioError('Please choose an MP3 (.mp3) file.');
      return;
    }
    if (file.size > MAX_GREETING_AUDIO_BYTES) {
      setAudioError(`Audio must be ${formatBytes(MAX_GREETING_AUDIO_BYTES)} or smaller.`);
      return;
    }

    setSelectedAudioTrack(null);
    setCustomAudioFile(file);
    setCustomAudioTrack('');
    setCustomAudioPreview((prev) => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });

    setIsUploadingAudio(true);
    try {
      const url = await uploadGreetingAudio(file);
      setCustomAudioTrack(url);
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : 'Could not upload your music.');
    } finally {
      setIsUploadingAudio(false);
    }
  };

  /**
   * Uploads through the `upload-image` Edge Function (the ImgBB key stays
   * server-side). Returns '' on failure so the payment flow is never blocked by
   * a photo problem — the card is simply created without one.
   */
  const uploadImage = async (file: File): Promise<string> => {
    try {
      return await uploadCardImageUrl(file);
    } catch (error) {
      console.error('Image upload failed:', error);
      return '';
    }
  };

  /**
   * Payload persisted before a Stripe redirect so the return page can create the
   * card. The photo is uploaded first because the server only accepts http(s)
   * image URLs (and the local preview is a data URL).
   */
  const prepareStripePayload = async (): Promise<PendingGreeting | null> => {
    if (!theme) return null;

    let imageUrl = '';
    if (imageFile) {
      imageUrl = await uploadImage(imageFile);
    } else if (imagePreview && /^https?:\/\//i.test(imagePreview)) {
      imageUrl = imagePreview;
    }

    return {
      sender_name: details.sender.trim(),
      receiver_name: details.receiver.trim(),
      message: details.message.trim(),
      theme: theme.id,
      font: fontId,
      title_color: titleColor || undefined,
      message_color: messageColor || undefined,
      signature_color: signatureColor || undefined,
      text_color: textColor || undefined,
      background_color_start: bgGradientStart || undefined,
      background_color_end: bgGradientEnd || undefined,
      background_gradient_angle: bgGradientAngle,
      title: title.trim() || undefined,
      eyebrow: eyebrow.trim() || undefined,
      signoff: signoff.trim() || undefined,
      audio_track: customAudioTrack || selectedAudioTrack || undefined,
      external_image_url: imageUrl,
      client_email: customerEmail,
      currency: 'USD',
    };
  };

  const generateCard = async (payment?: PaymentProof) => {
    setIsGenerating(true);
    try {
      const imageUrl = imageFile ? await uploadImage(imageFile) : imagePreview || '';

      /*
       * The free limit is per email, so the free flow collects its own address in
       * the builder; paid cards use the email typed at checkout.
       */
      const buyerEmail = usesFreeCardFlow ? freeEmail.trim() : customerEmail;
      if (usesFreeCardFlow) setCustomerEmail(buyerEmail);

      const cardInput = {
        sender_name: details.sender.trim(),
        receiver_name: details.receiver.trim(),
        message: details.message.trim(),
        theme: theme.id,
        font: fontId,
        title_color: titleColor || undefined,
        message_color: messageColor || undefined,
        signature_color: signatureColor || undefined,
        text_color: textColor || undefined,
        background_color_start: bgGradientStart || undefined,
        background_color_end: bgGradientEnd || undefined,
        background_gradient_angle: bgGradientAngle,
        title: title.trim() || undefined,
        eyebrow: eyebrow.trim() || undefined,
        signoff: signoff.trim() || undefined,
        audio_track: customAudioTrack || selectedAudioTrack || undefined,
        external_image_url: imageUrl,
        client_email: buyerEmail,
      };

      // The Edge Function is the authority: it verifies admin status from the
      // session JWT (or the payment with the gateway) before writing the card
      // and its ledger row. The free welcome card instead goes through
      // `create-free-greeting`, which enforces the per-email/per-IP free limit.
      const { card, transaction } = usesFreeCardFlow
        ? await createFreeGreetingCard(cardInput)
        : await createGreetingCard({
            ...cardInput,
            currency: isIndiaRegion ? 'INR' : 'USD',
            payment,
          });

      setCardLink(buildGreetingUrl(card.id));
      setManagementToken(card.management_token ?? '');
      setExpiresAt(card.expires_at ? new Date(card.expires_at) : null);

      // Issue a printable receipt for paid cards.
      if (!isFreeTheme && transaction?.payment_id) {
        const result = await fetchReceipt(transaction.payment_id);
        setReceiptHtml(result?.html ?? '');
        setReceiptNumber(result?.receipt.receipt_number ?? '');
        setReceiptEmailed(Boolean(result?.emailed));
      }

      /*
       * Thank-you + professional bill — sent on EVERY order, including admin
       * comps and the free welcome card.
       *
       *  • the bill always shows a Cost line: the product's real price, or
       *    ₹0.00 for a genuinely free card — never the word "free";
       *  • an admin comp is billed at the list price, so the receipt stays
       *    professional even though nothing was charged;
       *  • the owner automatically receives a copy from the send-email function.
       *
       * If the buyer left no email, the bill is addressed to the store owner so
       * the record is never lost.
       */
      void sendPurchaseEmail(buyerEmail, {
        name: details.sender.trim(),
        productName: `${theme.name} — Digital Greeting Card`,
        amount: isFreeTheme ? '0' : String(displayPrice),
        currency: isIndiaRegion ? 'INR' : 'USD',
        paymentId: transaction?.payment_id ?? '',
        orderDate: new Date().toDateString(),
        cardUrl: buildGreetingUrl(card.id),
      });

      setCreateError('');
      setCreateErrorRetryable(true);
      setLastPayment(null);
      clearPendingGreeting();
      setStep('done');
    } catch (error) {
      console.error('Failed to generate greeting card:', error);
      // Keep the payment proof so the sender can retry without paying again.
      // The server is idempotent on payment_id, so a retry after a lost
      // response returns the original card instead of charging twice.
      //
      // `retryable` is false for a reached free-card limit: the same request can
      // never succeed until the 24-hour window passes, so no Retry button.
      setCreateErrorRetryable((error as { retryable?: boolean })?.retryable !== false);
      setCreateError(
        error instanceof Error ? error.message : 'We could not create your card. Please try again.',
      );
      setLastPayment(payment ?? null);
      throw error;
    } finally {
      setIsGenerating(false);
    }
  };

  const handlePrimaryAction = async () => {
    if (!isDetailsValid || isUploadingAudio) return;

    setCustomerName(details.sender.trim());

    // Admins and the free welcome card skip payment entirely.
    if (isAdmin || isFreeTheme) {
      try {
        await generateCard();
      } catch {
        /* already surfaced to the user */
      }
      return;
    }

    setIsPaymentOpen(true);
  };

  const handlePaymentSuccess = async (payment: PaymentProof) => {
    setIsPaymentOpen(false);
    await generateCard(payment);
  };

  const openReceipt = () => {
    if (!receiptHtml) return;
    const blob = new Blob([receiptHtml], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank', 'noopener,noreferrer');
  };

  /** Saves the receipt as a file the buyer can keep or print. */
  const downloadReceipt = () => {
    if (!receiptHtml) return;
    const blob = new Blob([receiptHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${receiptNumber || 'ishmaverse-receipt'}.html`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(cardLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      alert(cardLink);
    }
  };

  return (
    <>
      {isOpen && !isPaymentOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 backdrop-blur-sm px-3 sm:px-6 pt-20 sm:pt-24 pb-12">
          <div className="relative w-full max-w-2xl bg-gradient-to-br from-bg-dark-start to-bg-dark-end border border-neon-purple/50 rounded-2xl shadow-2xl">
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors z-10"
              aria-label="Close"
            >
              <X className="w-6 h-6" />
            </button>

            <div className="p-5 sm:p-8">
              {/* Theme header */}
              <div className={`rounded-2xl bg-gradient-to-r ${theme.gradient} p-[2px] mb-6`}>
                <div className="bg-bg-dark-end/90 rounded-2xl px-5 py-4 flex items-center gap-4">
                  <span className="text-4xl">{theme.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-xl font-bold text-white truncate">{theme.name}</h2>
                    <p className="text-xs text-gray-400">{theme.tagline}</p>
                    {isAudioTier(theme.tier) && (
                      <div className="mt-2 text-[11px] font-semibold text-emerald-200">
                        {tierAudioLabel[theme.tier as AudioTier]}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xl font-black text-neon-purple">
                      {isAdmin || isFreeTheme ? 'FREE' : `${currencySymbol}${displayPrice}`}
                    </div>
                    <div className="text-[10px] uppercase tracking-wider text-gray-500">
                      {TIER_LABELS[theme.tier]}
                    </div>
                    <div className="text-[10px] text-gray-500">{TIER_TAGLINES[theme.tier]}</div>
                  </div>
                </div>
              </div>

              <AnimatePresence mode="wait">
                {step === 'details' && (
                  <motion.div
                    key="details"
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    className="space-y-4"
                  >
                    {isAdmin && (
                      <div className="flex items-center gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-2">
                        <ShieldCheck className="w-4 h-4" />
                        Admin session — this card will be generated free of charge.
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-semibold text-gray-300 mb-2">
                          Your name
                        </label>
                        <input
                          type="text"
                          value={details.sender}
                          onChange={(e) => setDetails({ ...details, sender: e.target.value })}
                          placeholder="Enter your name"
                          className="w-full bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-neon-purple transition-colors"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-semibold text-gray-300 mb-2">
                          Their name
                        </label>
                        <input
                          type="text"
                          value={details.receiver}
                          onChange={(e) => setDetails({ ...details, receiver: e.target.value })}
                          placeholder="Enter the recipient's name"
                          className="w-full bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-neon-purple transition-colors"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-gray-300 mb-2">
                        Your message
                      </label>
                      <textarea
                        value={details.message}
                        onChange={(e) => setDetails({ ...details, message: e.target.value })}
                        placeholder="Write your message..."
                        rows={4}
                        className="w-full bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-neon-purple transition-colors resize-none"
                      />
                    </div>

                    {/*
                     * The free card's limit is per email address, so the address has
                     * to be captured before the card is published. Paid cards collect
                     * it at checkout instead.
                     */}
                    {usesFreeCardFlow && (
                      <div>
                        <label className="block text-sm font-semibold text-gray-300 mb-2">
                          Your email address
                        </label>
                        <input
                          type="email"
                          value={freeEmail}
                          onChange={(e) => setFreeEmail(e.target.value)}
                          placeholder="you@example.com"
                          className={`w-full bg-bg-dark-start border rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none transition-colors ${
                            freeEmail.trim() && !isFreeEmailValid
                              ? 'border-red-500/60 focus:border-red-500'
                              : 'border-neon-purple/30 focus:border-neon-purple'
                          }`}
                        />
                        <p className="text-[11px] text-gray-500 mt-1">
                          Used only to enforce the free-card limit (one free card per email per
                          24 hours) and to send your receipt.
                        </p>
                        {freeEmail.trim() && !isFreeEmailValid && (
                          <p className="text-[11px] text-red-300 mt-1">
                            Enter a valid email address to publish this free card.
                          </p>
                        )}
                      </div>
                    )}

                    {/*
                     * Typography, custom wording and text/background colours are
                     * paid-theme features. The FREE Welcome Card keeps its own
                     * designed font and palette so it stays a one-tap card.
                     */}
                    {!isFreeTheme && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="block text-sm font-semibold text-gray-300">
                          Typography
                        </label>
                        <span className="text-[11px] text-gray-500">
                          {greetingFonts.length} styles · previewed live
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
                        {greetingFonts.map((font) => {
                          const active = font.id === fontId;
                          return (
                            <button
                              key={font.id}
                              type="button"
                              onClick={() => setFontId(font.id)}
                              title={font.mood}
                              aria-pressed={active}
                              className={`text-left rounded-xl border px-3 py-3 transition-all ${
                                active
                                  ? 'border-neon-purple bg-neon-purple/10 ring-1 ring-neon-purple/60'
                                  : 'border-neon-purple/25 bg-bg-dark-start hover:border-neon-purple/60'
                              }`}
                            >
                              {/* The sample renders in the font itself, so the look is
                               * visible while choosing (not only after applying). */}
                              <span
                                className="block text-lg leading-snug text-white truncate"
                                style={{ fontFamily: font.family }}
                              >
                                {font.sample}
                              </span>
                              <span className="mt-1 flex items-center justify-between gap-2">
                                <span className="text-[10px] uppercase tracking-wider text-gray-400 truncate">
                                  {font.label}
                                </span>
                                {active && <Check className="w-3.5 h-3.5 text-neon-purple shrink-0" />}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[11px] text-gray-500 mt-2">
                        <span className="text-gray-300 font-semibold">
                          {getFontById(fontId).label}
                        </span>{' '}
                        — best for: {getFontById(fontId).mood}
                      </p>
                    </div>
                    )}

                    {!isFreeTheme && (
                    <div>
                      <span className="block text-sm font-semibold text-gray-300 mb-2">
                        Card text <span className="text-gray-500 font-normal">(optional)</span>
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-gray-500">Heading (title)</span>
                          <input
                            type="text"
                            value={title}
                            maxLength={80}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder="e.g. Happy Birthday"
                            className="w-full bg-bg-dark-start border border-neon-purple/30 rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-neon-purple transition-colors"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-gray-500">Small label (eyebrow)</span>
                          <input
                            type="text"
                            value={eyebrow}
                            maxLength={60}
                            onChange={(e) => setEyebrow(e.target.value)}
                            placeholder="A LITTLE NOTE FOR YOU"
                            className="w-full bg-bg-dark-start border border-neon-purple/30 rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-neon-purple transition-colors"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] text-gray-500">Sign-off</span>
                          <input
                            type="text"
                            value={signoff}
                            maxLength={60}
                            onChange={(e) => setSignoff(e.target.value)}
                            placeholder="With love,"
                            className="w-full bg-bg-dark-start border border-neon-purple/30 rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-neon-purple transition-colors"
                          />
                        </label>
                      </div>
                      <p className="text-[11px] text-gray-500 mt-2">
                        Leave blank to keep the theme's wording. The recipient's name and your
                        message come from the fields above.
                      </p>
                    </div>
                    )}

                    {!isFreeTheme && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-gray-300">
                          Text colours <span className="text-gray-500 font-normal">(optional)</span>
                        </span>
                        {(titleColor || messageColor || signatureColor || textColor || bgGradientStart || bgGradientEnd) && (
                          <button
                            type="button"
                            onClick={() => {
                              setTitleColor('');
                              setMessageColor('');
                              setSignatureColor('');
                              setTextColor('');
                              setBgGradientStart('');
                              setBgGradientEnd('');
                            }}
                            className="text-[11px] font-semibold text-neon-purple hover:text-purple-300 transition-colors"
                          >
                            Reset to theme
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        {[
                          { label: 'Title colour', setter: setTitleColor, value: titleColor, fallback: theme.design.inkSoft },
                          { label: 'Message colour', setter: setMessageColor, value: messageColor, fallback: theme.design.ink },
                          { label: 'Signature colour', setter: setSignatureColor, value: signatureColor, fallback: theme.accent },
                        ].map((item) => (
                          <label key={item.label} className="flex items-center gap-3 bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 cursor-pointer">
                            <input
                              type="color"
                              value={item.value || item.fallback}
                              onChange={(e) => item.setter(e.target.value)}
                              className="h-9 w-12 rounded-md bg-transparent border-0 cursor-pointer appears-mobile"
                              aria-label={`Custom ${item.label}`}
                            />
                            <span className="text-sm text-gray-300 flex-1 min-w-0">
                              {item.label}
                              <span className="block text-[11px] text-gray-500">
                                {item.value ? item.value : 'Theme default'}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                        <label className="flex items-center gap-3 bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 cursor-pointer">
                          <input
                            type="color"
                            value={textColor || theme.design.ink}
                            onChange={(e) => setTextColor(e.target.value)}
                            className="h-9 w-12 rounded-md bg-transparent border-0 cursor-pointer"
                            aria-label="Custom text colour"
                          />
                          <span className="text-sm text-gray-300">
                            Text colour
                            <span className="block text-[11px] text-gray-500">
                              {textColor ? textColor : 'Theme default'}
                            </span>
                          </span>
                        </label>
                        <label className="flex items-center gap-3 bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 cursor-pointer">
                          <input
                            type="color"
                            value={bgGradientStart || theme.design.surface[0]}
                            onChange={(e) => setBgGradientStart(e.target.value)}
                            className="h-9 w-12 rounded-md bg-transparent border-0 cursor-pointer"
                            aria-label="Background gradient start colour"
                          />
                          <span className="text-sm text-gray-300">
                            Background start
                            <span className="block text-[11px] text-gray-500">
                              {bgGradientStart ? bgGradientStart : 'Theme gradient'}
                            </span>
                          </span>
                        </label>
                        <label className="flex items-center gap-3 bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 cursor-pointer">
                          <input
                            type="color"
                            value={bgGradientEnd || theme.design.surface[1] || theme.design.surface[0]}
                            onChange={(e) => setBgGradientEnd(e.target.value)}
                            className="h-9 w-12 rounded-md bg-transparent border-0 cursor-pointer"
                            aria-label="Background gradient end colour"
                          />
                          <span className="text-sm text-gray-300">
                            Background end
                            <span className="block text-[11px] text-gray-500">
                              {bgGradientEnd ? bgGradientEnd : 'Theme gradient'}
                            </span>
                          </span>
                        </label>
                      </div>

                      <div className="mt-3 space-y-3">
                        <div className="flex flex-wrap gap-2">
                          {GRADIENT_SWATCHES.map((swatch) => {
                            const active =
                              bgGradientStart.toLowerCase() === swatch.start.toLowerCase() &&
                              bgGradientEnd.toLowerCase() === swatch.end.toLowerCase();
                            return (
                              <button
                                key={swatch.label}
                                type="button"
                                onClick={() => {
                                  setBgGradientStart(swatch.start);
                                  setBgGradientEnd(swatch.end);
                                }}
                                title={swatch.label}
                                className={`h-8 w-12 rounded-lg border transition-transform hover:scale-105 ${
                                  active ? 'border-white ring-2 ring-neon-purple' : 'border-white/20'
                                }`}
                                style={{
                                  background: `linear-gradient(135deg, ${swatch.start}, ${swatch.end})`,
                                }}
                                aria-label={`${swatch.label} gradient`}
                              />
                            );
                          })}
                        </div>

                        <label className="flex items-center gap-3">
                          <span className="text-[11px] text-gray-500 w-24 shrink-0">
                            Direction {bgGradientAngle}°
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={359}
                            value={bgGradientAngle}
                            onChange={(e) => setBgGradientAngle(Number(e.target.value))}
                            className="flex-1 accent-[#8b5cf6]"
                            aria-label="Background gradient direction"
                          />
                          <span
                            aria-hidden
                            className="h-8 w-8 rounded-lg border border-white/20 shrink-0"
                            style={{
                              background:
                                bgGradientStart || bgGradientEnd
                                  ? `linear-gradient(${bgGradientAngle}deg, ${
                                      bgGradientStart || theme.design.surface[0]
                                    }, ${
                                      bgGradientEnd || theme.design.surface[1] || theme.design.surface[0]
                                    })`
                                  : `linear-gradient(${bgGradientAngle}deg, ${theme.design.surface.join(', ')})`,
                            }}
                          />
                        </label>
                      </div>
                      <p className="text-[11px] text-gray-500 mt-2">
                        Leave untouched to keep the theme's designed palette, or pick your own to
                        make the card truly yours.
                      </p>
                    </div>
                    )}

                    {isFreeTheme && (
                      <div className="rounded-xl border border-neon-purple/25 bg-bg-dark-start px-4 py-3">
                        <span className="block text-sm font-semibold text-gray-200">
                          Free Welcome Card — simple by design
                        </span>
                        <span className="mt-1 block text-[11px] leading-relaxed text-gray-500">
                          Your names, message and photo are all you need. Font choice, custom
                          wording, text colours and background music come with the paid themes —
                          pick any paid card if you want to style it your way.
                        </span>
                      </div>
                    )}

                    {theme && (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-gray-300">
                            Audio <span className="text-gray-500 font-normal">(optional)</span>
                          </span>
                          {(selectedAudioTrack || customAudioFile || customAudioTrack) && (
                            <button
                              type="button"
                              onClick={clearCustomAudio}
                              className="text-[11px] font-semibold text-neon-purple hover:text-purple-300 transition-colors"
                            >
                              Clear audio
                            </button>
                          )}
                        </div>
                        {isAudioTier(theme.tier) ? (
                          <>
                            <label className="flex flex-col gap-1 bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 cursor-pointer">
                              <span className="text-sm text-gray-300">
                                {tierAudioLabel[theme.tier as AudioTier]}
                              </span>
                              <select
                                value={selectedAudioTrack || ''}
                                onChange={(e) => setSelectedAudioTrack(e.target.value)}
                                className="w-full bg-bg-dark-end border border-neon-purple/30 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-neon-purple transition-colors"
                              >
                                <option value="">No audio track</option>
                                {Object.entries(AUDIO_TRACKS_BY_CATEGORY).map(([categoryId, path]) => {
                                  const label = categoryId
                                    .split('_')
                                    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                                    .join(' ');
                                  return (
                                    <option key={path} value={path}>
                                      {label} — {path.split('/').pop()}
                                    </option>
                                  );
                                })}
                                <option value={DEFAULT_AUDIO_TRACKS}>
                                  Default — {DEFAULT_AUDIO_TRACKS.split('/').pop()}
                                </option>
                              </select>
                            </label>

                            {/* Upload your own MP3 — Premium & Elite only. */}
                            <div className="bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 space-y-3">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm text-gray-300">
                                  Or upload your own song
                                  <span className="block text-[11px] text-gray-500">
                                    Premium &amp; Elite · .mp3 up to {formatBytes(MAX_GREETING_AUDIO_BYTES)}
                                  </span>
                                </span>
                                {isUploadingAudio && (
                                  <span className="inline-flex items-center gap-1 text-[11px] text-neon-purple shrink-0">
                                    <Loader2 className="w-3 h-3 animate-spin" /> Uploading…
                                  </span>
                                )}
                              </div>

                              <div
                                onClick={() => document.getElementById('custom-audio-input')?.click()}
                                className="border border-dashed border-neon-purple/30 rounded-lg px-3 py-3 text-center cursor-pointer hover:border-neon-purple transition-colors"
                              >
                                {customAudioFile ? (
                                  <span className="text-xs text-neon-purple">
                                    {customAudioFile.name} · Click to replace
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-2 text-sm text-gray-400">
                                    <Upload className="w-4 h-4" />
                                    Choose an .mp3 from your device
                                  </span>
                                )}
                                <input
                                  id="custom-audio-input"
                                  type="file"
                                  accept="audio/mpeg,.mp3"
                                  onChange={handleCustomAudioChange}
                                  className="hidden"
                                />
                              </div>

                              {audioError && (
                                <p className="text-[11px] text-red-300">{audioError}</p>
                              )}

                              {customAudioPreview && (
                                <audio
                                  key={customAudioPreview}
                                  src={customAudioPreview}
                                  controls
                                  preload="metadata"
                                  className="w-full h-9"
                                >
                                  Your browser does not support audio playback.
                                </audio>
                              )}

                              <p className="text-[11px] text-gray-500">
                                Your song plays when the card is opened and takes priority over the
                                stock track above.
                              </p>
                            </div>

                            {/* Preview the chosen stock track before publishing. The player is
                             * keyed on the track so switching selection reloads it. */}
                            {selectedAudioTrack && !customAudioFile && (
                              <div className="bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-xs text-gray-300 font-semibold">
                                    Preview track
                                  </span>
                                  <a
                                    href={selectedAudioTrack}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[11px] text-neon-purple hover:text-purple-300"
                                  >
                                    Open in new tab
                                  </a>
                                </div>
                                <audio
                                  key={selectedAudioTrack}
                                  src={selectedAudioTrack}
                                  controls
                                  preload="none"
                                  className="w-full h-9"
                                >
                                  Your browser does not support audio playback.
                                </audio>
                                <p className="text-[11px] text-gray-500 mt-2">
                                  Press play to hear this track — you can change it any time before
                                  paying.
                                </p>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="bg-bg-dark-start border border-gray-700/40 rounded-xl px-4 py-3 text-sm text-gray-400">
                            {theme.tier === 'basic'
                              ? 'This tier does not include audio.'
                              : 'Audio selection is available for Premium and Elite tiers.'}
                          </div>
                        )}
                      </div>
                    )}

                    <div>
                      <label className="block text-sm font-semibold text-gray-300 mb-2">
                        Photo (optional)
                      </label>
                      <div
                        onClick={() => document.getElementById('theme-photo-input')?.click()}
                        className="border-2 border-dashed border-neon-purple/30 rounded-xl p-4 text-center cursor-pointer hover:border-neon-purple transition-colors"
                      >
                        {imagePreview ? (
                          <div>
                            <div className="w-36 h-36 mx-auto">
                              <PhotoFrame
                                frame={theme.design.frame}
                                accent={theme.accent}
                                glow={theme.design.glow}
                                src={imagePreview}
                                alt="Photo preview"
                                compact
                                className="w-full h-full"
                              />
                            </div>
                            <div className="mt-2 text-neon-purple text-xs">Click to change</div>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setCropSrc(originalImageSrc || imagePreview);
                              }}
                              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neon-purple/50 text-neon-purple text-xs font-semibold hover:bg-neon-purple/10 transition-all"
                            >
                              <Crop className="w-3.5 h-3.5" />
                              Adjust crop
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-2 text-gray-400 text-sm py-2">
                            <Upload className="w-5 h-5" />
                            Upload a photo
                          </div>
                        )}
                        <input
                          id="theme-photo-input"
                          type="file"
                          accept="image/*"
                          onChange={handleImageChange}
                          className="hidden"
                        />
                      </div>
                    </div>

                    <div className="pt-1">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-gray-300">Live preview — free</span>
                        <button
                          type="button"
                          onClick={() => setIsPreviewOpen(true)}
                          disabled={!isDetailsValid}
                          className="flex items-center gap-1 text-[11px] font-semibold text-neon-purple hover:text-purple-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                          <Eye className="w-3 h-3" />
                          Open full preview
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsPreviewOpen(true)}
                        disabled={!isDetailsValid}
                        className="block w-full text-left disabled:cursor-not-allowed"
                        aria-label="Open full card preview"
                      >
                        <GreetingCardVisual
                          theme={theme}
                          senderName={details.sender}
                          receiverName={details.receiver}
                          message={details.message}
                          imageUrl={imagePreview ?? undefined}
                          fontId={fontId}
                          titleColor={titleColor || undefined}
                          messageColor={messageColor || undefined}
                          signatureColor={signatureColor || undefined}
                          textColor={textColor || undefined}
                          bgGradientStart={bgGradientStart || undefined}
                          bgGradientEnd={bgGradientEnd || undefined}
                          bgGradientAngle={bgGradientAngle}
                          title={title || undefined}
                          eyebrow={eyebrow || undefined}
                          signoff={signoff || undefined}
                          compact
                        />
                      </button>
                      <p className="mt-2 text-[11px] text-gray-500 text-center">
                        Previewing is always free — the shareable link is created only after
                        payment succeeds.
                      </p>
                    </div>

                    {createError && (
                      <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 space-y-2">
                        <p className="text-xs text-red-300">{createError}</p>
                        {createErrorRetryable ? (
                          <button
                            type="button"
                            onClick={() => {
                              void generateCard(lastPayment ?? undefined).catch(() => {});
                            }}
                            disabled={isGenerating}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/50 text-red-200 text-xs font-semibold hover:bg-red-500/30 disabled:opacity-50 transition-all"
                          >
                            {isGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                            {isGenerating ? 'Retrying…' : 'Retry creating card'}
                          </button>
                        ) : (
                          <p className="text-[11px] text-red-200/80">
                            Retrying this exact request will not help yet — choose a paid card, or
                            come back after the 24-hour window.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="flex flex-col sm:flex-row gap-3">
                      <button
                        type="button"
                        onClick={() => setIsPreviewOpen(true)}
                        disabled={!isDetailsValid || isGenerating || isUploadingAudio}
                        className="flex items-center justify-center gap-2 px-6 py-4 rounded-xl border border-neon-purple/50 text-neon-purple font-bold hover:bg-neon-purple/10 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                      >
                        <Eye className="w-5 h-5" />
                        Preview
                      </button>

                      <button
                        onClick={handlePrimaryAction}
                        disabled={!isDetailsValid || isGenerating || isUploadingAudio}
                        className="flex-1 group relative disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <div className="absolute inset-0 bg-gradient-to-r from-neon-purple via-purple-500 to-neon-purple rounded-xl blur opacity-50 group-hover:opacity-100 transition duration-300" />
                        <div className="relative flex items-center justify-center gap-2 bg-bg-dark-end border border-neon-purple rounded-xl px-6 py-4 font-bold text-white transition-all duration-300">
                          {isGenerating ? (
                            <>
                              <Loader2 className="w-5 h-5 animate-spin" />
                              Generating...
                            </>
                          ) : isAdmin || isFreeTheme ? (
                            <>
                              {isAdmin ? 'Generate Free Card' : 'Publish Free Card'}
                              <ArrowRight className="w-5 h-5" />
                            </>
                          ) : (
                            <>
                              Publish & Get Link · {currencySymbol}{displayPrice}
                              <ArrowRight className="w-5 h-5" />
                            </>
                          )}
                        </div>
                      </button>
                    </div>

                    {isFreeTheme && !isAdmin && (
                      <p className="text-[11px] text-emerald-300/80 text-center">
                        This welcome card is free — one free card per email (max two per network).
                      </p>
                    )}
                    {!isAdmin && !isFreeTheme && (
                      <p className="text-[11px] text-gray-500 text-center">
                        Your 48-hour live link is issued immediately after payment. UPI and cards
                        within India; PayPal elsewhere.
                        {isPaymentDemoMode() && ' Demo mode is on — no real payment will be processed.'}
                      </p>
                    )}
                  </motion.div>
                )}

                {step === 'done' && (
                  <motion.div
                    key="done"
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="space-y-5"
                  >
                    <div className="text-center">
                      <div className="relative w-16 h-16 mx-auto mb-4">
                        <div className="absolute inset-0 bg-gradient-to-r from-neon-purple to-purple-500 rounded-full blur-xl opacity-60 animate-pulse" />
                        <div className="relative w-16 h-16 bg-bg-dark-end border-2 border-neon-purple rounded-full flex items-center justify-center">
                          <Check className="w-8 h-8 text-neon-purple" />
                        </div>
                      </div>
                      <h2 className="text-2xl font-bold text-white">Your card is ready! 🎉</h2>
                      <p className="text-sm text-gray-400 mt-1">
                        Share this link with the person you're thinking of
                      </p>
                    </div>

                    <div className="flex gap-2">
                      <input
                        value={cardLink}
                        readOnly
                        onFocus={(e) => e.currentTarget.select()}
                        className="flex-1 min-w-0 bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 text-white text-sm"
                      />
                      <button
                        onClick={copyLink}
                        className="flex items-center gap-2 px-5 py-3 bg-neon-purple text-white rounded-xl font-semibold hover:bg-purple-600 transition-all shrink-0"
                      >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>

                    <p className="text-[11px] text-gray-500 text-center">
                      Your card is live for 48 hours and carries the permanent “Created with ✨”
                      watermark.
                    </p>

                    {managementToken && (
                      <p className="text-[11px] text-gray-500 text-center">
                        Need to take it down early?{' '}
                        <a
                          href={buildManageUrl(managementToken)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-neon-purple hover:text-purple-300 font-semibold"
                        >
                          Manage or delete your card
                        </a>
                      </p>
                    )}

                    <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-xl px-4 py-3 flex items-start gap-3">
                      <Clock className="w-5 h-5 text-yellow-300 shrink-0 mt-0.5" />
                      <div className="text-xs text-yellow-200">
                        <p className="font-semibold">
                          This card stays live for 48 hours
                          {expiresAt ? ` — expires in ${formatCountdown(remainingMs)}` : ''}
                        </p>
                        <p className="text-yellow-200/80 mt-1">
                          Once the 48 hours are up, the link expires automatically and the card is
                          removed from our system. We recommend sharing it soon.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-3">
                      <a
                        href={cardLink}
                        target="_blank"
                        rel="noreferrer"
                        className="flex-1 flex items-center justify-center gap-2 px-6 py-3 border border-neon-purple rounded-xl text-neon-purple font-semibold hover:bg-neon-purple hover:text-white transition-all"
                      >
                        <ExternalLink className="w-4 h-4" />
                        Preview Card
                      </a>
                      <button
                        onClick={onClose}
                        className="flex-1 px-6 py-3 border border-gray-700 rounded-xl text-gray-300 font-semibold hover:border-gray-500 hover:text-white transition-all"
                      >
                        Done
                      </button>
                    </div>

                    {receiptHtml && (
                      <div className="bg-bg-dark-start border border-neon-purple/30 rounded-xl p-4 text-left space-y-3">
                        <div className="flex items-start gap-2">
                          <Mail className="w-4 h-4 text-emerald-300 shrink-0 mt-0.5" />
                          <div className="text-xs text-gray-300">
                            <p className="font-semibold text-white">
                              Receipt {receiptNumber && `#${receiptNumber}`}
                            </p>
                            <p className="text-gray-400 mt-0.5">
                              {receiptEmailed
                                ? `Emailed to ${customerEmail || 'your inbox'} automatically.`
                                : 'Your receipt is ready — download or print it below.'}
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <button
                            onClick={downloadReceipt}
                            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-neon-purple/15 border border-neon-purple/40 text-neon-purple text-xs font-semibold hover:bg-neon-purple/25 transition-all"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Download receipt
                          </button>
                          <button
                            onClick={openReceipt}
                            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-gray-700 text-gray-300 text-xs font-semibold hover:border-gray-500 hover:text-white transition-all"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            View / print
                          </button>
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      )}

      {isPaymentOpen && checkoutProduct && (
        <CheckoutModal
          product={checkoutProduct}
          isOpen={isPaymentOpen}
          onClose={() => setIsPaymentOpen(false)}
          onPaymentSuccess={handlePaymentSuccess}
          onPrepareStripe={prepareStripePayload}
        />
      )}

      <GreetingPreviewModal
        theme={theme}
        isOpen={isPreviewOpen}
        onClose={() => setIsPreviewOpen(false)}
        senderName={details.sender}
        receiverName={details.receiver}
        message={details.message}
        fontId={fontId}
        imageUrl={imagePreview ?? undefined}
        titleColor={titleColor || undefined}
        messageColor={messageColor || undefined}
        signatureColor={signatureColor || undefined}
        textColor={textColor || undefined}
        bgGradientStart={bgGradientStart || undefined}
        bgGradientEnd={bgGradientEnd || undefined}
        bgGradientAngle={bgGradientAngle}
        title={title || undefined}
        eyebrow={eyebrow || undefined}
        signoff={signoff || undefined}
        audioTrack={customAudioPreview || customAudioTrack || selectedAudioTrack || undefined}
        isAdmin={isAdmin}
        ctaLabel={
          isAdmin || isFreeTheme
            ? 'Publish free card'
            : `Publish & get link · ${currencySymbol}${displayPrice}`
        }
        onPublish={() => {
          setIsPreviewOpen(false);
          void handlePrimaryAction();
        }}
      />

      {cropSrc && (
        <ImageCropper
          src={cropSrc}
          onCancel={() => setCropSrc(null)}
          onApply={handleCropApply}
        />
      )}
    </>
  );
};
