import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  CheckCircle2,
  Clock,
  Smartphone,
  Landmark,
  Wallet,
  CreditCard,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import { PayPalScriptProvider, PayPalButtons } from '@paypal/react-paypal-js';
import { Product, PaymentProof } from '../types';
import { useGreeting } from '../context/GreetingContext';
import { supabase } from '../services/supabase';
import { isPaymentDemoMode } from '../services/greetingService';
import { useCurrency } from '../context/CurrencyContext';
import { clearPendingGreeting, savePendingGreeting, type PendingGreeting } from '../services/pendingCheckout';
import { FunctionRequestError, readFunctionFailure } from '../services/functionErrors';

interface CheckoutModalProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
  /** Receives gateway-verified proof that the server will re-validate. */
  onPaymentSuccess?: (payment: PaymentProof) => void | Promise<void>;
  /** 'demo' skips the gateway so the flow can be tested before keys are added. */
  paymentMode?: 'live' | 'demo';
  /**
   * Greeting flow only: returns the payload to persist before a Stripe redirect.
   * When absent, Stripe is not offered (e.g. plain store products).
   */
  onPrepareStripe?: () => Promise<PendingGreeting | null>;
}

type PaymentState = 'checkout' | 'processing' | 'success';
type IntlProvider = 'paypal' | 'stripe';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Theme id is encoded in the product id as `greeting-<themeId>`. */
const themeIdFromProduct = (product: Product | null): string =>
  product ? product.id.replace(/^greeting-/, '') : '';

/** Methods a Razorpay India checkout exposes. */
const INDIA_METHODS = [
  { label: 'UPI', icon: Smartphone },
  { label: 'PhonePe', icon: Smartphone },
  { label: 'Google Pay', icon: Smartphone },
  { label: 'Amazon Pay', icon: Wallet },
  { label: 'BHIM', icon: Landmark },
  { label: 'Net Banking', icon: Landmark },
  { label: 'Cards', icon: CreditCard },
  { label: 'Wallets', icon: Wallet },
];

export const CheckoutModal: React.FC<CheckoutModalProps> = ({
  product,
  isOpen,
  onClose,
  onPaymentSuccess,
  paymentMode = isPaymentDemoMode() ? 'demo' : 'live',
  onPrepareStripe,
}) => {
  const [paymentState, setPaymentState] = useState<PaymentState>('checkout');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const { isIndia } = useCurrency();
  const [isPreparingPayment, setIsPreparingPayment] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const stripeConfigured = Boolean(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY);
  const paypalConfigured = Boolean(import.meta.env.VITE_PAYPAL_CLIENT_ID);
  const [intlProvider, setIntlProvider] = useState<IntlProvider>(
    onPrepareStripe && stripeConfigured ? 'stripe' : 'paypal',
  );
  const {
    customerName: contextName,
    customerEmail: contextEmail,
    setCustomerName: setContextName,
    setCustomerEmail: setContextEmail,
  } = useGreeting();
  const navigate = useNavigate();

  useEffect(() => {
    if (isOpen) {
      setPaymentState('checkout');
      // Carry over what the sender already typed in the builder.
      setCustomerName(contextName || '');
      setCustomerEmail(contextEmail || '');
      setPaymentError('');
    }
    // Intentionally keyed on `isOpen` only: re-running on context changes would
    // reset the form mid-payment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const isEmailValid = EMAIL_PATTERN.test(customerEmail.trim());
  const canPay = customerName.trim().length > 0 && isEmailValid;
  const showEmailHint = customerEmail.trim().length > 0 && !isEmailValid;

  const handlePaymentSuccess = async (payment: PaymentProof) => {
    setPaymentError('');
    setPaymentState('processing');
    setContextName(customerName.trim());
    setContextEmail(customerEmail.trim());

    if (onPaymentSuccess) {
      try {
        // The card + ledger row are written server-side here, after the payment
        // proof has been (re)verified against the gateway.
        await onPaymentSuccess(payment);
      } catch (error) {
        console.error('Post-payment handler failed:', error);
        setPaymentError(
          error instanceof Error ? error.message : 'We could not finish your order.',
        );
        setPaymentState('checkout');
        return;
      }
    }

    setPaymentState('success');
  };

  /**
   * Asks the server for a gateway order priced from the trusted price table.
   *
   * The browser sends only the theme id and currency — never an amount. A
   * failure arrives as a typed error: `PAYMENT_CONFIG` means the owner must fix
   * the gateway keys, `NETWORK` means the function could not be reached, and a
   * retryable server error can simply be attempted again.
   */
  const createServerOrder = async (currency: 'INR' | 'USD', provider?: IntlProvider) => {
    const { data, error } = await supabase.functions.invoke('create-payment-order', {
      body: { theme_id: themeIdFromProduct(product), currency, provider },
    });
    if (error || !data?.success) {
      throw new FunctionRequestError(await readFunctionFailure(error, data));
    }
    return data as {
      provider: 'razorpay' | 'paypal' | 'stripe';
      key_id?: string;
      order_id?: string;
      session_id?: string;
      url?: string;
      amount: number;
      currency: string;
    };
  };

  const loadRazorpayScript = () => {
    return new Promise((resolve) => {
      if ((window as any).Razorpay) {
        resolve(true);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  const handleRazorpayPayment = async () => {
    /*
     * Defence in depth: a ₹0 card must never start a gateway checkout, whatever
     * price the browser was handed. The server refuses a ₹0 order too.
     */
    if (!product || !(Number(product.price) > 0)) {
      setPaymentError(
        'This card is free — no payment is required. Close this dialog and publish it from the card builder.',
      );
      return;
    }

    setPaymentError('');
    setIsPreparingPayment(true);

    try {
      const order = await createServerOrder('INR');
      const ready = await loadRazorpayScript();
      if (!ready) throw new Error('Razorpay SDK failed to load. Please retry.');

      const options = {
        key: order.key_id,
        amount: order.amount,
        currency: order.currency,
        order_id: order.order_id,
        name: 'isZma',
        description: product!.name,
        handler: async (response: any) => {
          await handlePaymentSuccess({
            provider: 'razorpay',
            order_id: response.razorpay_order_id,
            payment_id: response.razorpay_payment_id,
            signature: response.razorpay_signature,
          });
        },
        prefill: { name: customerName.trim(), email: customerEmail.trim() },
        theme: { color: '#8b5cf6' },
        // Explicitly enable the Indian rails: UPI (PhonePe, GPay, BHIM),
        // Amazon Pay / wallets, netbanking and cards. The Razorpay dashboard
        // still decides which of these your account has activated.
        method: {
          upi: true,
          card: true,
          netbanking: true,
          wallet: true,
          paylater: true,
        },
      };

      const razorpay = new (window as any).Razorpay(options);
      razorpay.open();
    } catch (error) {
      console.error('Could not start Razorpay checkout:', error);
      setPaymentError(error instanceof Error ? error.message : 'Could not start payment.');
    } finally {
      setIsPreparingPayment(false);
    }
  };

  /** Stripe hosted checkout: persist the card, create a session, then redirect. */
  const handleStripePayment = async () => {
    if (!product || !(Number(product.price) > 0)) {
      setPaymentError('This card is free — no payment is required.');
      return;
    }

    setPaymentError('');
    setIsPreparingPayment(true);

    try {
      if (!onPrepareStripe) throw new Error('Stripe checkout is unavailable for this item.');

      const pending = await onPrepareStripe();
      if (!pending) throw new Error('Could not prepare your card details. Please retry.');

      const order = await createServerOrder('USD', 'stripe');
      if (!order.url) throw new Error('Stripe did not return a checkout link.');

      // Persist only after the session exists, then hand off to Stripe.
      savePendingGreeting(pending);
      window.location.href = order.url;
    } catch (error) {
      clearPendingGreeting();
      console.error('Could not start Stripe checkout:', error);
      setPaymentError(error instanceof Error ? error.message : 'Could not start Stripe checkout.');
      setIsPreparingPayment(false);
    }
  };

  if (!isOpen || !product) return null;

  const isGreetingCard = product.id === 'greeting-card';
  // Theme cards use `greeting-<themeId>`; the legacy card uses `greeting-card`.
  const isGreetingProduct = product.id.startsWith('greeting');
  const isDemo = paymentMode === 'demo';
  const priceLabel = `${product.currency === 'INR' ? '₹' : '$'}${product.price}`;
  /*
   * A free card (₹0 / $0) has no gateway step. Treating it as a purchase used to
   * render a "Pay ₹0 with Razorpay" button that could only fail.
   */
  const isZeroPayable = !(Number(product.price) > 0);
  const stripeAvailable = Boolean(onPrepareStripe) && isGreetingProduct;

  const missingGateway = isDemo
    ? false
    : isIndia
      ? !import.meta.env.VITE_RAZORPAY_KEY_ID
      : intlProvider === 'stripe'
        ? !stripeConfigured
        : !paypalConfigured;

  const requiredKey = isIndia
    ? ' VITE_RAZORPAY_KEY_ID'
    : intlProvider === 'stripe'
      ? ' VITE_STRIPE_PUBLISHABLE_KEY'
      : ' VITE_PAYPAL_CLIENT_ID';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 backdrop-blur-sm px-4 pt-20 sm:pt-24 pb-12">
      <div className="relative w-full max-w-lg bg-gradient-to-br from-bg-dark-start to-bg-dark-end border border-neon-purple/50 rounded-2xl shadow-2xl overflow-hidden">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors z-10"
        >
          <X className="w-6 h-6" />
        </button>

        <div className="p-6 sm:p-8">
          {paymentState === 'checkout' && (
            <div className="space-y-6">
              <div className="text-center space-y-2">
                <h2 className="text-2xl sm:text-3xl font-bold text-white">Checkout</h2>
                <p className="text-gray-400">{product.name}</p>
                <p className="text-3xl font-black bg-gradient-to-r from-neon-purple to-purple-400 bg-clip-text text-transparent">
                  {priceLabel}
                </p>
                <p className="text-[11px] uppercase tracking-wider text-gray-500">
                  {isIndia ? 'Paying in INR (₹)' : 'Paying in USD ($)'}
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-300 mb-2">Full Name</label>
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="w-full bg-bg-dark-end border border-neon-purple/30 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-neon-purple transition-colors"
                    placeholder="Enter your name"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-300 mb-2">Email Address</label>
                  <input
                    type="email"
                    value={customerEmail}
                    onChange={(e) => setCustomerEmail(e.target.value)}
                    className={`w-full bg-bg-dark-end border rounded-xl px-4 py-3 text-white focus:outline-none transition-colors ${
                      showEmailHint
                        ? 'border-red-500/60 focus:border-red-500'
                        : 'border-neon-purple/30 focus:border-neon-purple'
                    }`}
                    placeholder="you@example.com"
                  />
                  {showEmailHint && (
                    <p className="text-[11px] text-red-300 mt-1.5">
                      Enter a valid email address — your receipt is sent there.
                    </p>
                  )}
                </div>

                {isGreetingProduct && (
                  <div className="flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 text-xs text-yellow-200">
                    <Clock className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      Your greeting card link stays live for 48 hours once it is created — your
                      recipient should open it within that window.
                    </span>
                  </div>
                )}

                {missingGateway && (
                  <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 text-xs text-red-300">
                    Payment gateway keys are not configured. Add
                    {requiredKey} to your <span className="font-mono">.env</span> file, or set{' '}
                    <span className="font-mono">VITE_PAYMENT_MODE=demo</span> to test the flow.
                  </div>
                )}

                {paymentError && (
                  <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 text-xs text-red-300">
                    {paymentError}
                  </div>
                )}

                {isZeroPayable ? (
                  <div className="space-y-3">
                    <div className="bg-emerald-500/10 border border-emerald-500/40 rounded-xl px-4 py-3 text-xs text-emerald-200 space-y-1">
                      <p className="font-semibold text-emerald-100">No payment is required for this card.</p>
                      <p>
                        This card is free, so it is published directly — no Razorpay or PayPal
                        checkout is started. Close this dialog and use the publish button.
                      </p>
                    </div>
                    <button
                      onClick={onClose}
                      className="w-full bg-bg-dark-end border border-neon-purple rounded-xl px-6 py-4 font-bold text-white hover:border-neon-purple transition-all duration-300"
                    >
                      Back to the free card
                    </button>
                  </div>
                ) : isDemo ? (
                  <div className="space-y-3">
                    <div className="bg-yellow-500/10 border border-yellow-500/40 rounded-xl px-4 py-3 text-xs text-yellow-300">
                      Demo mode active — no real money moves. Turn it off by removing
                      <span className="font-mono"> VITE_PAYMENT_MODE=demo</span> once your gateway keys are in.
                    </div>
                    <button
                      onClick={() =>
                        handlePaymentSuccess({
                          provider: 'demo',
                          payment_id: `DEMO-${crypto.randomUUID()}`,
                        })
                      }
                      disabled={!canPay}
                      className="w-full group relative disabled:opacity-50"
                    >
                      <div className="absolute inset-0 bg-gradient-to-r from-neon-purple via-purple-500 to-neon-purple rounded-xl blur opacity-50 group-hover:opacity-100 transition duration-300" />
                      <div className="relative bg-bg-dark-end border border-neon-purple rounded-xl px-6 py-4 font-bold text-white transition-all duration-300">
                        Simulate Payment ({priceLabel})
                      </div>
                    </button>
                  </div>
                ) : isIndia ? (
                  <div className="space-y-4">
                    {/* Indian rails, powered by Razorpay */}
                    <div>
                      <p className="text-xs text-gray-400 mb-2 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-300" />
                        Pay securely with any Indian method
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {INDIA_METHODS.map((method) => {
                          const Icon = method.icon;
                          return (
                            <span
                              key={method.label}
                              className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-300 bg-white/5 border border-white/10 rounded-full px-3 py-1.5"
                            >
                              <Icon className="w-3.5 h-3.5 text-neon-purple" />
                              {method.label}
                            </span>
                          );
                        })}
                      </div>
                    </div>

                    <button
                      onClick={handleRazorpayPayment}
                      disabled={!canPay || isPreparingPayment}
                      className="w-full group relative disabled:opacity-50"
                    >
                      <div className="absolute inset-0 bg-gradient-to-r from-neon-purple via-purple-500 to-neon-purple rounded-xl blur opacity-50 group-hover:opacity-100 transition duration-300" />
                      <div className="relative flex items-center justify-center gap-2 bg-bg-dark-end border border-neon-purple rounded-xl px-6 py-4 font-bold text-white transition-all duration-300">
                        {isPreparingPayment && <Loader2 className="w-4 h-4 animate-spin" />}
                        {isPreparingPayment ? 'Preparing secure checkout…' : `Pay ${priceLabel} with Razorpay`}
                      </div>
                    </button>
                    <p className="text-[11px] text-gray-500 text-center">
                      UPI · PhonePe · Google Pay · Amazon Pay · BHIM · Net Banking · Cards · Wallets
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* International: Stripe (card / bank) or PayPal, both settle to INR */}
                    {stripeAvailable ? (
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          onClick={() => setIntlProvider('stripe')}
                          className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border transition-all ${
                            intlProvider === 'stripe'
                              ? 'bg-neon-purple/15 border-neon-purple text-white'
                              : 'bg-white/5 border-white/10 text-gray-400 hover:text-white'
                          }`}
                        >
                          <CreditCard className="w-4 h-4" />
                          Card / Bank
                        </button>
                        <button
                          onClick={() => setIntlProvider('paypal')}
                          className={`flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border transition-all ${
                            intlProvider === 'paypal'
                              ? 'bg-neon-purple/15 border-neon-purple text-white'
                              : 'bg-white/5 border-white/10 text-gray-400 hover:text-white'
                          }`}
                        >
                          <Wallet className="w-4 h-4" />
                          PayPal
                        </button>
                      </div>
                    ) : null}

                    {intlProvider === 'stripe' && stripeAvailable ? (
                      <div className="space-y-3">
                        <button
                          onClick={handleStripePayment}
                          disabled={!canPay || isPreparingPayment}
                          className="w-full group relative disabled:opacity-50"
                        >
                          <div className="absolute inset-0 bg-gradient-to-r from-neon-purple via-purple-500 to-neon-purple rounded-xl blur opacity-50 group-hover:opacity-100 transition duration-300" />
                          <div className="relative flex items-center justify-center gap-2 bg-bg-dark-end border border-neon-purple rounded-xl px-6 py-4 font-bold text-white transition-all duration-300">
                            {isPreparingPayment && <Loader2 className="w-4 h-4 animate-spin" />}
                            {isPreparingPayment ? 'Redirecting to Stripe…' : `Pay ${priceLabel} with Stripe`}
                          </div>
                        </button>
                        <p className="text-[11px] text-gray-500 text-center">
                          Secure card & bank checkout. You will be redirected to Stripe and back.
                        </p>
                      </div>
                    ) : (
                      <PayPalScriptProvider options={{ clientId: import.meta.env.VITE_PAYPAL_CLIENT_ID }}>
                        <PayPalButtons
                          style={{ layout: 'vertical' }}
                          disabled={!canPay}
                          createOrder={async () => {
                            try {
                              // Amount and currency are decided by the server.
                              const order = await createServerOrder('USD', 'paypal');
                              return order.order_id ?? '';
                            } catch (error) {
                              const message =
                                error instanceof Error ? error.message : 'Could not start payment.';
                              setPaymentError(message);
                              throw error;
                            }
                          }}
                          onApprove={async (data: any) => {
                            // Captured + verified server-side inside create-greeting.
                            await handlePaymentSuccess({
                              provider: 'paypal',
                              order_id: data.orderID,
                              payment_id: data.orderID,
                            });
                          }}
                        />
                      </PayPalScriptProvider>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {paymentState === 'processing' && (
            <div className="text-center py-12 space-y-4">
              <div className="animate-spin w-12 h-12 border-4 border-neon-purple border-t-transparent rounded-full mx-auto" />
              <h2 className="text-xl font-bold text-white">Processing Payment...</h2>
              <p className="text-gray-400">Please wait while we verify your transaction</p>
            </div>
          )}

          {paymentState === 'success' && (
            <div className="text-center space-y-6 py-4">
              <div className="relative w-20 h-20 mx-auto">
                <div className="absolute inset-0 bg-gradient-to-r from-neon-purple to-purple-500 rounded-full blur-xl opacity-50 animate-pulse" />
                <div className="relative w-20 h-20 bg-bg-dark-end border-2 border-neon-purple rounded-full flex items-center justify-center">
                  <CheckCircle2 className="w-10 h-10 text-neon-purple" />
                </div>
              </div>
              <div className="space-y-2">
                <h2 className="text-2xl sm:text-3xl font-bold text-white">Payment Successful!</h2>
                <p className="text-gray-400">Thank you for your purchase</p>
              </div>
              {isGreetingCard && (
                <div className="bg-bg-dark-end border border-neon-purple/30 rounded-xl p-4">
                  <p className="text-white font-semibold mb-2">Ready to create your greeting card?</p>
                  <p className="text-sm text-gray-400">Click below to start making your magical card!</p>
                </div>
              )}
              <div className="flex gap-4">
                {isGreetingCard ? (
                  <button
                    onClick={() => navigate('/section/greetings')}
                    className="flex-1 group relative"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-neon-purple via-purple-500 to-neon-purple rounded-xl blur opacity-50 group-hover:opacity-100 transition duration-300" />
                    <div className="relative bg-bg-dark-end border border-neon-purple rounded-xl px-6 py-4 font-bold text-white group-hover:border-neon-purple transition-all duration-300">
                      Continue
                    </div>
                  </button>
                ) : (
                  <button
                    onClick={onClose}
                    className="w-full group relative"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-neon-purple via-purple-500 to-neon-purple rounded-xl blur opacity-50 group-hover:opacity-100 transition duration-300" />
                    <div className="relative bg-bg-dark-end border border-neon-purple rounded-xl px-6 py-4 font-bold text-white group-hover:border-neon-purple transition-all duration-300">
                      Done
                    </div>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
