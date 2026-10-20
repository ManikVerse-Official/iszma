import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { BrandProvider } from './context/BrandContext.tsx'
import { GreetingProvider } from './context/GreetingContext.tsx'
import { CatalogProvider } from './context/CatalogContext.tsx'
import { CurrencyProvider } from './context/CurrencyContext.tsx'
import { BrowserRouter } from 'react-router-dom'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/*
      * React Router 6 prints two console warnings on every page load
      * (v7_startTransition and v7_relativeSplatPath). Both flags are opted in
      * here, which silences the warnings by adopting the v7 behaviour up front.
      * This app has no splat routes (all paths are static segments or single
      * params), so relativeSplatPath changes nothing about where links go.
      */}
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <CurrencyProvider>
      <CatalogProvider>
        <BrandProvider>
          <GreetingProvider>
            <App />
          </GreetingProvider>
        </BrandProvider>
      </CatalogProvider>
      </CurrencyProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
