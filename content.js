// Main content script for the Charles Schwab Tax Lot Extractor
let extractionState = {
  isRunning: false,
  currentIndex: 0,
  totalPositions: 0,
  processedButtons: new Set(),
  taxLotData: {},
  errors: [],
};

let overlay = null;
let progressBar = null;

// Safe logging to prevent crashes if the extension's log function is missing
const safeLog = (...args) => {
  console.log("[Schwab Extractor]", ...args);
  try { if (typeof log === 'function') log(...args); } catch (e) {}
};

// Initialize the content script
async function init() {
  safeLog("Content script initialized");
  await loadState();
  chrome.runtime.onMessage.addListener(handleMessage);
  if (extractionState.isRunning) {
    resumeExtraction();
  }
}

function handleMessage(message, sender, sendResponse) {
  switch (message.action) {
    case "START_EXTRACTION":
      startExtraction();
      sendResponse({ success: true });
      break;
    case "STOP_EXTRACTION":
      stopExtraction();
      sendResponse({ success: true });
      break;
    case "GET_STATE":
      sendResponse({
        progress: {
          isRunning: extractionState.isRunning,
          currentIndex: extractionState.currentIndex,
          totalPositions: extractionState.totalPositions,
        },
        hasData: Object.keys(extractionState.taxLotData).length > 0,
      });
      break;
    default:
      sendResponse({ error: "Unknown action" });
      break;
  }
}

function findNextStepButtons() {
  const selectors = [
    'button[id^="menu-trigger-next-steps-"]',
    'sdps-button[sdps-id^="menu-trigger-next-steps-"] button',
    'app-next-steps-column button',
    'button[aria-label="Open Menu"]'
  ];
  
  let buttons = [];
  for (const selector of selectors) {
    try {
      const found = Array.from(document.querySelectorAll(selector));
      if (found.length > 0) {
        buttons = found;
        break;
      }
    } catch (e) {}
  }
  
  if (buttons.length === 0) {
    const allButtons = Array.from(document.querySelectorAll('tr[app-position-row] button, .position-row button, button'));
    buttons = allButtons.filter(btn => {
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const id = btn.id || '';
      const html = btn.innerHTML || '';
      return ariaLabel.includes('Open Menu') || id.includes('next-steps') || id.includes('menu') || html.includes('icon-sch-menu-flyout');
    });
  }
  return buttons;
}

function triggerLotDetailsClick() {
  const textSpans = Array.from(document.querySelectorAll('.sdps-menu__item-text, span'));
  const targetSpan = textSpans.find(span => (span.textContent || '').trim() === 'Lot Details');

  if (targetSpan) {
    const menuItemDiv = targetSpan.closest('[role="menuitem"], .sdps-menu__item, div') || targetSpan;
    menuItemDiv.click();
    const clickEvent = new MouseEvent('click', { view: window, bubbles: true, cancelable: true, buttons: 1 });
    menuItemDiv.dispatchEvent(clickEvent);
    return true;
  }
  return false;
}

// 100% ALIGNED SCRAPER: Includes CSV Comma Escaping to prevent column shifts
function scrapeOpenModalLots() {
  const lots = [];
  try {
    const rows = document.querySelectorAll('#responsiveLotTable tbody tr.data-row');
    rows.forEach(row => {
      
      const cleanText = (selector) => {
        const el = row.querySelector(selector);
        if (!el) return '';
        
        // Clean whitespace and tabs
        let text = el.textContent.replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
        
        // IMPORTANT: If the text contains a comma (like "$137,397.00"), wrap it in double quotes
        // This prevents the CSV exporter from splitting the number into multiple columns
        if (text.includes(',')) {
          text = `"${text}"`;
        }
        
        return text;
      };

      const openDate = cleanText('th'); 
      const quantity = cleanText('td[name="Qty"]');
      const price = cleanText('td[name="Price"]');
      const costPerShare = cleanText('td[name="CPS"]');
      const marketValue = cleanText('td[name="MktVal"]');
      const costBasis = cleanText('td[name="CostBasis"]');
      const gainLossDollar = cleanText('td[name="GainLoss"]');
      const gainLossPercent = cleanText('td[name="GainLossPercent"]');
      const holdingPeriod = cleanText('td[name="HoldPeriod"]');

      if (openDate && quantity && !openDate.toLowerCase().includes('total')) {
        lots.push({
          open_date: openDate,
          quantity: quantity,
          price: price,
          cost_per_share: costPerShare,
          market_value: marketValue,
          cost_basis: costBasis,
          gain_or_loss: gainLossDollar,
          gain_or_loss_percentage: gainLossPercent,
          holding_period: holdingPeriod
        });
      }
    });
  } catch (error) {
    safeLog("Scraper error:", error);
  }
  return lots;
}

// LOCAL DATA BUILDER: Safely structures the export data
function safeAppendTaxLotData(accountId, symbol, lots) {
  if (!extractionState.taxLotData[accountId]) {
    extractionState.taxLotData[accountId] = [];
  }
  
  let symbolFound = false;
  for (let i = 0; i < extractionState.taxLotData[accountId].length; i++) {
    if (extractionState.taxLotData[accountId][i][symbol]) {
      extractionState.taxLotData[accountId][i][symbol] = extractionState.taxLotData[accountId][i][symbol].concat(lots);
      symbolFound = true;
      break;
    }
  }
  
  if (!symbolFound) {
    let newSymbolObj = {};
    newSymbolObj[symbol] = lots;
    extractionState.taxLotData[accountId].push(newSymbolObj);
  }
}

function extractSymbolLocally(button) {
  try {
    const row = button.closest('tr');
    if (row) {
      const symbolEl = row.querySelector('a[href*="symbol="], [data-symbol]');
      if (symbolEl) return (symbolEl.getAttribute('data-symbol') || symbolEl.textContent).trim();
    }
  } catch (e) {}
  return "UNKNOWN_SYMBOL";
}

// AGGRESSIVE MODAL CLOSER: Guarantees the window disappears
function forceCloseModal() {
  try {
    const closeBtns = document.querySelectorAll('.sdps-modal__close, button[aria-label="Close"]');
    closeBtns.forEach(btn => btn.click());

    const allBtns = document.querySelectorAll('button');
    allBtns.forEach(btn => {
      if (btn.innerHTML.includes('17.706 6.294')) {
        btn.click();
      }
    });

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));

    const modals = document.querySelectorAll('sdps-modal, .sdps-modal, [class*="modal"]');
    modals.forEach(m => {
      if (m.innerHTML.includes('Lot Details')) {
        m.style.display = 'none';
        m.style.opacity = '0';
        m.style.pointerEvents = 'none';
      }
    });
  } catch (e) {
    safeLog("Error forcing modal close:", e);
  }
}

async function startExtraction() {
  if (extractionState.isRunning) return;

  try {
    if (!window.location.href.includes("client.schwab.com/app/accounts/positions")) {
      sendProgressUpdate("Error: Wrong page", 0, 0);
      return;
    }

    const buttons = findNextStepButtons();
    safeLog(`Found ${buttons.length} Next Steps buttons`);

    if (buttons.length === 0) {
      sendProgressUpdate("Error: No buttons found", 0, 0);
      return;
    }

    extractionState.isRunning = true;
    extractionState.currentIndex = 0;
    extractionState.totalPositions = buttons.length;
    extractionState.processedButtons.clear();
    extractionState.taxLotData = {};
    extractionState.errors = [];

    await saveState();
    createOverlay();

    sendProgressUpdate("Starting extraction...", 0, buttons.length);
    processNextButton(buttons);
  } catch (error) {
    safeLog("Error starting extraction:", error);
    sendError("Failed to start extraction: " + error.message);
  }
}

async function processNextButton(buttons) {
  if (!extractionState.isRunning || extractionState.currentIndex >= buttons.length) {
    await completeExtraction();
    return;
  }

  const button = buttons[extractionState.currentIndex];
  const currentPosition = extractionState.currentIndex + 1;

  sendProgressUpdate("Processing position...", currentPosition, buttons.length);
  highlightElement(button);

  try {
    // 1. Open context menu
    button.click();

    // 2. Click "Lot Details"
    await new Promise(r => setTimeout(r, 600));
    const clickedLotDetails = triggerLotDetailsClick();

    if (!clickedLotDetails) {
      throw new Error("Could not click 'Lot Details'");
    }

    // 3. Wait for the popup modal to fully render the table
    await new Promise(r => setTimeout(r, 2000));

    // 4. Scrape the data locally using the precise keys
    const extractedLots = scrapeOpenModalLots();
    const symbol = extractSymbolLocally(button);
    const accountId = "MainAccount"; 

    if (extractedLots.length > 0) {
      safeAppendTaxLotData(accountId, symbol, extractedLots);
      safeLog(`Successfully extracted ${extractedLots.length} lots for ${symbol}`);
    } else {
      extractionState.errors.push({
        timestamp: new Date().toISOString(),
        accountId: accountId,
        symbol: symbol,
        error: "Modal opened but scraper found no rows",
      });
    }

    // 5. Aggressively close the modal
    forceCloseModal();
    await new Promise(r => setTimeout(r, 800));

  } catch (error) {
    safeLog(`Error processing button ${currentPosition}:`, error);
    forceCloseModal(); // Failsafe cleanup
  }

  unhighlightElement(button);
  extractionState.currentIndex++;
  
  try {
    await saveState();
  } catch (e) {
    safeLog("Non-fatal error saving state:", e);
  }

  setTimeout(() => {
    processNextButton(buttons);
  }, 1500);
}

async function completeExtraction() {
  extractionState.isRunning = false;
  await saveState();
  removeOverlay();

  const totalSymbols = countSymbols(extractionState.taxLotData);
  const totalPositions = countPositions(extractionState.taxLotData);

  safeLog(`Extraction complete! Found ${totalSymbols} symbols with ${totalPositions} total positions`);

  chrome.runtime.sendMessage({
    action: "EXTRACTION_COMPLETE",
    data: {
      total: extractionState.totalPositions,
      symbols: totalSymbols,
      positions: totalPositions,
      errors: extractionState.errors.length,
    },
  });
}

async function stopExtraction() {
  if (!extractionState.isRunning) return;
  extractionState.isRunning = false;
  await saveState();
  removeOverlay();

  chrome.runtime.sendMessage({
    action: "EXTRACTION_STOPPED",
    data: {
      progress: `${extractionState.currentIndex}/${extractionState.totalPositions}`,
      hasData: Object.keys(extractionState.taxLotData).length > 0,
    },
  });
}

async function resumeExtraction() {
  const buttons = findNextStepButtons();
  if (buttons.length === 0) {
    extractionState.isRunning = false;
    await saveState();
    return;
  }
  createOverlay();
  processNextButton(buttons);
}

function createOverlay() {
  progressBar = document.createElement("div");
  progressBar.className = "schwab-extractor-progress";
  progressBar.innerHTML = '<div class="schwab-extractor-progress-bar" style="width: 0%"></div>';
  document.body.appendChild(progressBar);

  overlay = document.createElement("div");
  overlay.className = "schwab-extractor-overlay";
  overlay.innerHTML = `
    <div class="schwab-extractor-status">
      <h3 style="margin: 0 0 1rem 0; font-size: 1.125rem; font-weight: bold;">Tax Lot Extraction in Progress</h3>
      <p style="margin: 0 0 0.5rem 0; color: #4b5563;">Processing position <span id="current-position">0</span> of <span id="total-positions">0</span></p>
      <p style="margin: 0; color: #6b7280; font-size: 0.875rem;">Please do not navigate away from this page</p>
    </div>
  `;
  document.body.appendChild(overlay);
}

function removeOverlay() {
  if (progressBar) { progressBar.remove(); progressBar = null; }
  if (overlay) { overlay.remove(); overlay = null; }
}

function updateProgressBar(current, total) {
  if (progressBar) {
    const percentage = total > 0 ? (current / total) * 100 : 0;
    const bar = progressBar.querySelector(".schwab-extractor-progress-bar");
    if (bar) bar.style.width = `${percentage}%`;
  }
  if (overlay) {
    const currentEl = overlay.querySelector("#current-position");
    const totalEl = overlay.querySelector("#total-positions");
    if (currentEl) currentEl.textContent = current;
    if (totalEl) totalEl.textContent = total;
  }
}

function highlightElement(element) { element.classList.add("schwab-extractor-highlight"); }
function unhighlightElement(element) { element.classList.remove("schwab-extractor-highlight"); }

function sendProgressUpdate(status, current, total) {
  updateProgressBar(current, total);
  chrome.runtime.sendMessage({
    action: "PROGRESS_UPDATE",
    data: { status: status, current: current, total: total },
  });
}

function sendError(error) {
  chrome.runtime.sendMessage({
    action: "EXTRACTION_ERROR",
    data: { error: error, progress: `${extractionState.currentIndex}/${extractionState.totalPositions}` },
  });
}

async function saveState() {
  try {
    if (typeof saveProgress === 'function') {
      await saveProgress({
        isRunning: extractionState.isRunning,
        currentIndex: extractionState.currentIndex,
        totalPositions: extractionState.totalPositions,
        lastUpdated: Date.now(),
      });
      await saveExtractedData(extractionState.taxLotData);
      await saveErrors(extractionState.errors);
    }
  } catch (e) {
    safeLog("Error in external save state routines, continuing anyway.", e);
  }
}

async function loadState() {
  try {
    if (typeof loadProgress === 'function') {
      const progress = await loadProgress();
      const data = await loadExtractedData();
      const errors = await loadErrors();
      extractionState.isRunning = progress.isRunning;
      extractionState.currentIndex = progress.currentIndex;
      extractionState.totalPositions = progress.totalPositions;
      extractionState.taxLotData = data || {};
      extractionState.errors = errors || [];
    }
  } catch (error) {}
}

function countSymbols(taxLotData) {
  let count = 0;
  Object.values(taxLotData).forEach(accountData => {
    accountData.forEach(symbolObj => { count += Object.keys(symbolObj).length; });
  });
  return count;
}

function countPositions(taxLotData) {
  let count = 0;
  Object.values(taxLotData).forEach(accountData => {
    accountData.forEach(symbolObj => {
      Object.values(symbolObj).forEach(lots => { count += lots.length; });
    });
  });
  return count;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}