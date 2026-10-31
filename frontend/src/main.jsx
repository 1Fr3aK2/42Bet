import React from 'react';
import ReactDOM from 'react-dom/client';
import AnalyticsDashboard from './components/Analytics/AnalyticsDashboard';
import App from './App';
import LegalFooter from './components/Legal/LegalFooter';
import './style.css';
import './responsive.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AnalyticsDashboard />
    <App />
    <LegalFooter />
  </React.StrictMode>
);
