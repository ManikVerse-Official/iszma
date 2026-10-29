import { useState } from 'react';
import { Navbar } from '../components/Navbar';
import { Hero } from '../components/Hero';
import { SectionsGrid } from '../components/SectionsGrid';
import { Footer } from '../components/Footer';
import { Chatbot } from '../components/Chatbot';
import { IsZmaWatermarkBg } from '../components/brand/IsZmaWatermarkBg';
import { usePageMeta } from '../hooks/usePageMeta';
import { DEFAULT_DESCRIPTION, DEFAULT_TITLE } from '../services/seo';

export const Home: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');

  usePageMeta({ title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, path: '/' });

  return (
    <div className="relative isolate min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end">
      <IsZmaWatermarkBg />
      <Navbar searchTerm={searchTerm} setSearchTerm={setSearchTerm} />
      <main className="pt-10 sm:pt-16">
        <Hero />
        <SectionsGrid searchTerm={searchTerm} />
      </main>
      <Footer />
      <Chatbot />
    </div>
  );
};
