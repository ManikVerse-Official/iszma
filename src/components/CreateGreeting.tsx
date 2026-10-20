import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Check, ArrowLeft, Upload, Loader2, Copy } from 'lucide-react';
import { useGreeting } from '../context/GreetingContext';
import { SmartImage } from './SmartImage';
import { buildGreetingUrl, createGreetingCard } from '../services/greetingService';
import { uploadCardImageUrl } from '../services/imageUpload';

type Step = 1 | 2 | 3 | 4 | 5;

export const CreateGreeting = () => {
  const [step, setStep] = useState<Step>(1);
  const [senderName, setSenderName] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [message, setMessage] = useState('');
  const [theme, setTheme] = useState<'Birthday' | 'Valentine'>('Birthday');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [cardLink, setCardLink] = useState<string | null>(null);
  const { customerName, isAdmin, adminLoading } = useGreeting();
  const navigate = useNavigate();

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => setImagePreview(reader.result as string);
      reader.readAsDataURL(file);
    }
  };

  /**
   * The photo is uploaded by the `upload-image` Edge Function, so the image-host
   * API key is never shipped to the browser.
   */
  const uploadImage = (file: File): Promise<string> => uploadCardImageUrl(file);

  const handleGenerateCard = async () => {
    if (!imageFile) return;

    setIsGenerating(true);
    try {
      // Upload image to ImgBB
      const imageUrl = await uploadImage(imageFile);

      // Creation goes through the secure create-greeting function. This legacy
      // wizard is admin-only, so the server confirms the session and writes the
      // card + ledger row itself (no client-side transaction insert).
      const { card } = await createGreetingCard({
        sender_name: senderName || customerName,
        receiver_name: receiverName,
        message,
        theme,
        external_image_url: imageUrl,
        currency: 'INR',
      });

      setCardLink(buildGreetingUrl(card.id));
      setStep(5);
    } catch (error) {
      console.error('Error generating card:', error);
      alert(error instanceof Error ? error.message : 'Failed to generate card. Please try again.');
    } finally {
      setIsGenerating(false);
    }
  };

  const copyLink = () => {
    if (cardLink) {
      navigator.clipboard.writeText(cardLink);
      alert('Link copied to clipboard!');
    }
  };

  const steps = [
    {
      number: 1,
      title: 'Who is this from?',
      content: (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-2">Your Name</label>
            <input
              type="text"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="Enter your name"
              className="w-full bg-bg-dark-end border border-neon-purple/30 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-neon-purple transition-colors"
            />
          </div>
        </div>
      ),
      isValid: senderName.trim().length > 0,
    },
    {
      number: 2,
      title: "Who's it for?",
      content: (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-2">Receiver's Name</label>
            <input
              type="text"
              value={receiverName}
              onChange={(e) => setReceiverName(e.target.value)}
              placeholder="Enter their name"
              className="w-full bg-bg-dark-end border border-neon-purple/30 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-neon-purple transition-colors"
            />
          </div>
        </div>
      ),
      isValid: receiverName.trim().length > 0,
    },
    {
      number: 3,
      title: 'Your special message',
      content: (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold text-gray-300 mb-2">Message</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Write your heartfelt message..."
              rows={6}
              className="w-full bg-bg-dark-end border border-neon-purple/30 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-neon-purple transition-colors resize-none"
            />
          </div>
        </div>
      ),
      isValid: message.trim().length > 0,
    },
    {
      number: 4,
      title: 'Choose a theme',
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <button
              onClick={() => setTheme('Birthday')}
              className={`relative p-6 rounded-xl border-2 transition-all ${
                theme === 'Birthday'
                  ? 'border-neon-purple bg-neon-purple/10'
                  : 'border-gray-700 bg-bg-dark-end hover:border-gray-600'
              }`}
            >
              <div className="text-4xl mb-2">🎂</div>
              <div className="font-semibold text-white">Birthday</div>
            </button>
            <button
              onClick={() => setTheme('Valentine')}
              className={`relative p-6 rounded-xl border-2 transition-all ${
                theme === 'Valentine'
                  ? 'border-neon-purple bg-neon-purple/10'
                  : 'border-gray-700 bg-bg-dark-end hover:border-gray-600'
              }`}
            >
              <div className="text-4xl mb-2">❤️</div>
              <div className="font-semibold text-white">Valentine</div>
            </button>
          </div>
          <div className="space-y-2">
            <label className="block text-sm font-semibold text-gray-300 mb-2">Upload Photo</label>
            <div
              onClick={() => document.getElementById('image-upload')?.click()}
              className="border-2 border-dashed border-neon-purple/30 rounded-xl p-8 text-center cursor-pointer hover:border-neon-purple transition-colors"
            >
              {imagePreview ? (
                <div className="relative">
                  <SmartImage
                    src={imagePreview}
                    alt="Preview"
                    className="max-h-48 mx-auto rounded-lg object-cover"
                  />
                  <div className="mt-2 text-neon-purple text-sm">Click to change</div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="w-12 h-12 text-gray-500 mx-auto" />
                  <div className="text-gray-400">Click to upload or drag and drop</div>
                </div>
              )}
              <input
                id="image-upload"
                type="file"
                accept="image/*"
                onChange={handleImageChange}
                className="hidden"
              />
            </div>
          </div>
        </div>
      ),
      isValid: !!imageFile,
    },
  ];

  const currentStep = steps[step - 1];

  // This legacy wizard cannot charge for a card, so it must never mint a free
  // one for a visitor. It is reserved for verified admins; everyone else is
  // routed to the paid theme flow (which handles payment before creation).
  if (adminLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end flex items-center justify-center">
        <div className="animate-spin w-12 h-12 border-4 border-neon-purple border-t-transparent rounded-full"></div>
      </div>
    );
  }
  if (!isAdmin) {
    return <Navigate to="/section/greetings" replace />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end px-4 md:px-8 pt-24 pb-16">
      <div className="max-w-2xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <button
            onClick={() => navigate('/')}
            className="text-gray-400 hover:text-white transition-colors"
          >
            ← Back
          </button>
          <div className="text-gray-400">Step {step} of 5</div>
        </div>

        <AnimatePresence mode="wait">
          {step < 5 ? (
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
            >
              <div className="mb-8">
                <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">{currentStep.title}</h1>
              </div>

              <div className="bg-bg-dark-end border border-neon-purple/30 rounded-2xl p-6 md:p-8">
                {currentStep.content}
              </div>

              <div className="flex gap-4 mt-8">
                {step > 1 && (
                  <button
                    onClick={() => setStep((s) => (s - 1) as Step)}
                    className="flex-1 flex items-center justify-center gap-2 px-6 py-4 border border-gray-700 rounded-xl text-gray-400 hover:border-gray-600 hover:text-white transition-all"
                  >
                    <ArrowLeft className="w-5 h-5" />
                    Previous
                  </button>
                )}
                <button
                  onClick={() => {
                    if (step === 4) {
                      handleGenerateCard();
                    } else {
                      setStep((s) => (s + 1) as Step);
                    }
                  }}
                  disabled={!currentStep.isValid}
                  className={`flex-1 flex items-center justify-center gap-2 px-6 py-4 rounded-xl font-semibold transition-all ${
                    currentStep.isValid
                      ? 'bg-neon-purple text-white hover:bg-purple-600'
                      : 'bg-gray-800 text-gray-600 cursor-not-allowed'
                  }`}
                >
                  {step === 4 ? (
                    <>
                      {isGenerating ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          Generating...
                        </>
                      ) : (
                        <>
                          Generate Card
                          <ArrowRight className="w-5 h-5" />
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      Next
                      <ArrowRight className="w-5 h-5" />
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="text-center"
            >
              <div className="relative w-24 h-24 mx-auto mb-8">
                <div className="absolute inset-0 bg-gradient-to-r from-neon-purple to-purple-500 rounded-full blur-xl opacity-50 animate-pulse" />
                <div className="relative w-24 h-24 bg-bg-dark-end border-2 border-neon-purple rounded-full flex items-center justify-center">
                  <Check className="w-12 h-12 text-neon-purple" />
                </div>
              </div>
              <h1 className="text-3xl md:text-4xl font-bold text-white mb-4">Your card is ready! 🎉</h1>
              <p className="text-gray-400 mb-8">Share this link with your special someone:</p>
              <div className="flex gap-4 mb-8">
                <input
                  value={cardLink || ''}
                  readOnly
                  className="flex-1 bg-bg-dark-end border border-neon-purple/30 rounded-xl px-4 py-3 text-white"
                />
                <button
                  onClick={copyLink}
                  className="flex items-center gap-2 px-6 py-3 bg-neon-purple text-white rounded-xl font-semibold hover:bg-purple-600 transition-all"
                >
                  <Copy className="w-5 h-5" />
                  Copy
                </button>
              </div>
              <button
                onClick={() => navigate('/')}
                className="inline-block px-8 py-4 border border-neon-purple rounded-xl text-neon-purple font-semibold hover:bg-neon-purple hover:text-white transition-all"
              >
                Create Another Card
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
