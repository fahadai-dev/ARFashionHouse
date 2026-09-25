// ==================================================================
// কাপড়ের দোকান POS — app.js
// ==================================================================

let CURRENT_USER = null;
let CURRENT_PROFILE = null;
let CURRENT_SHOP = null;
let PRODUCTS_CACHE = [];
let CUSTOMERS_CACHE = [];
let CART = []; // [{product_id, name, code, qty, price, stock_qty}]
let isSignupMode = false;
let html5QrInstance = null;
let scannerTargetMode = "pos"; // 'pos' or 'productForm'
let pendingLogoDataUrl = null;
let activeCustomerId = null;

// ---------------------------------------------------------------
// INIT
// ---------------------------------------------------------------
window.addEventListener("DOMContentLoaded", async () => {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  if (session) {
    await bootAfterLogin(session.user);
  }
  document.getElementById("reportDate").valueAsDate = new Date();

  // global scanner buffer for USB/keyboard-wedge scanners on POS page
  document.getElementById("scanInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScannedCode(document.getElementById("scanInput").value.trim());
      document.getElementById("scanInput").value = "";
    }
  });
});

// ---------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------
function toggleAuthMode() {
  isSignupMode = !isSignupMode;
  document.getElementById("signupExtra").style.display = isSignupMode
    ? "block"
    : "none";
  document.getElementById("authSubtitle").textContent = isSignupMode
    ? "নতুন দোকানের অ্যাকাউন্ট তৈরি করুন"
    : "আপনার দোকানের অ্যাকাউন্টে লগইন করুন";
  document.getElementById("authSubmitBtn").textContent = isSignupMode
    ? "রেজিস্টার করুন"
    : "লগইন করুন";
  document.getElementById("toggleText").textContent = isSignupMode
    ? "অ্যাকাউন্ট আছে?"
    : "অ্যাকাউন্ট নেই?";
  document.getElementById("toggleModeBtn").textContent = isSignupMode
    ? "লগইন করুন"
    : "নতুন দোকান রেজিস্টার করুন";
  hideAuthMsgs();
}

function hideAuthMsgs() {
  document.getElementById("authError").style.display = "none";
  document.getElementById("authSuccess").style.display = "none";
}
function showAuthError(msg) {
  const el = document.getElementById("authError");
  el.textContent = msg;
  el.style.display = "block";
}
function showAuthSuccess(msg) {
  const el = document.getElementById("authSuccess");
  el.textContent = msg;
  el.style.display = "block";
}

async function handleAuthSubmit() {
  hideAuthMsgs();
  const email = document.getElementById("emailInput").value.trim();
  const password = document.getElementById("passwordInput").value;
  if (!email || !password) {
    showAuthError("ইমেইল ও পাসওয়ার্ড দিন");
    return;
  }

  if (isSignupMode) {
    const shopName =
      document.getElementById("shopNameInput").value.trim() || "আমার দোকান";
    const fullName = document.getElementById("fullNameInput").value.trim();

    // shop_name/full_name auth metadata হিসেবে পাঠানো হচ্ছে, যাতে
    // schema.sql এর handle_new_user() ট্রিগার সঠিক নাম দিয়েই
    // shop + profile তৈরি করে। client-side থেকে আলাদা করে
    // shop/profile insert করার দরকার নেই।
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: { shop_name: shopName, full_name: fullName },
      },
    });
    if (error) {
      showAuthError(error.message);
      return;
    }
    if (data.session) {
      await bootAfterLogin(data.user);
    } else {
      showAuthSuccess("অ্যাকাউন্ট তৈরি হয়েছে। এখন লগইন করুন।");
      toggleAuthMode();
    }
  } else {
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      showAuthError("ভুল ইমেইল অথবা পাসওয়ার্ড");
      return;
    }
    await bootAfterLogin(data.user);
  }
}

async function logout() {
  await supabaseClient.auth.signOut();
  location.reload();
}

async function bootAfterLogin(user) {
  CURRENT_USER = user;
  const { data: profile, error: pErr } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  if (pErr || !profile) {
    showAuthError("প্রোফাইল লোড করা যায়নি");
    return;
  }
  CURRENT_PROFILE = profile;

  const { data: shop } = await supabaseClient
    .from("shops")
    .select("*")
    .eq("id", profile.shop_id)
    .single();
  CURRENT_SHOP = shop;

  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("appShell").style.display = "flex";
  document.getElementById("shopNameDisplay").textContent =
    shop?.name || "দোকান";
  document.getElementById("userNameDisplay").textContent =
    profile.full_name || "";
  document.getElementById("settingsShopName").value = shop?.name || "";
  document.getElementById("settingsShopAddr").value = shop?.address || "";
  applyLogoToUI(shop?.logo_url);
  document.getElementById("todayDateLabel").textContent =
    new Date().toLocaleDateString("bn-BD", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

  await loadProducts();
  await loadCustomers();
  await loadDashboard();
}

function applyLogoToUI(logoUrl) {
  const sidebarLogo = document.getElementById("sidebarLogo");
  const preview = document.getElementById("logoPreview");
  if (logoUrl) {
    sidebarLogo.src = logoUrl;
    sidebarLogo.style.display = "block";
    preview.innerHTML = `<img src="${logoUrl}" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    sidebarLogo.style.display = "none";
    preview.innerHTML = "🖼️";
  }
}

function handleLogoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingLogoDataUrl = reader.result;
    document.getElementById("logoPreview").innerHTML =
      `<img src="${pendingLogoDataUrl}" style="width:100%;height:100%;object-fit:cover;">`;
  };
  reader.readAsDataURL(file);
}

// ---------------------------------------------------------------
// NAVIGATION
// ---------------------------------------------------------------
const pageTitles = {
  dashboard: "ড্যাশবোর্ড",
  stock: "স্টক / পণ্য",
  pos: "বিক্রয় (POS)",
  report: "দিনের হিসাব",
  ledger: "বাকির খাতা",
  settings: "সেটিংস",
};
function switchPage(page) {
  document.querySelectorAll(".page").forEach((p) => (p.style.display = "none"));
  document.getElementById("page-" + page).style.display = "block";
  document
    .querySelectorAll(".nav-item")
    .forEach((n) => n.classList.remove("active"));
  document
    .querySelector(`.nav-item[data-page="${page}"]`)
    .classList.add("active");
  document.getElementById("mobileTitle").textContent = pageTitles[page];
  closeSidebar();
  if (page === "dashboard") loadDashboard();
  if (page === "report") loadDayReport();
  if (page === "ledger") renderLedger();
  if (page === "pos") {
    CART = [];
    renderCart();
    onPaymentMethodChange();
    document.getElementById("scanInput").focus();
  }
}
function openSidebar() {
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("mobileOverlay").classList.add("show");
}
function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("mobileOverlay").classList.remove("show");
}

// ---------------------------------------------------------------
// PRODUCTS / STOCK
// ---------------------------------------------------------------
async function loadProducts() {
  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .order("created_at", { ascending: false });
  if (!error) PRODUCTS_CACHE = data || [];
  renderProducts();
}

function renderProducts() {
  const search = document.getElementById("productSearch").value.toLowerCase();
  const lowOnly = document.getElementById("lowStockFilter").value === "low";
  const body = document.getElementById("productsBody");
  let list = PRODUCTS_CACHE.filter(
    (p) =>
      p.name.toLowerCase().includes(search) ||
      p.code.toLowerCase().includes(search) ||
      (p.category || "").toLowerCase().includes(search),
  );
  if (lowOnly) list = list.filter((p) => p.stock_qty <= 5);

  body.innerHTML =
    list
      .map(
        (p) => `
    <tr>
      <td><input type="checkbox" class="prod-check" value="${p.id}"></td>
      <td><strong>${escapeHtml(p.name)}</strong><br><small style="color:var(--muted)">${escapeHtml(p.category || "")} ${escapeHtml(p.size || "")}</small></td>
      <td><span class="badge ${p.code_type === "qr" ? "qr" : "barcode"}">${p.code_type === "qr" ? "QR" : "বারকোড"}</span><br><code style="font-size:11px">${escapeHtml(p.code)}</code></td>
      <td>৳${Number(p.sell_price).toFixed(0)}</td>
      <td><span class="badge ${p.stock_qty <= 5 ? "low" : "ok"}">${p.stock_qty}</span></td>
      <td>
        <button class="btn-sm gray" onclick="editProduct('${p.id}')">এডিট</button>
        <button class="btn-sm gray" onclick="printSingleLabel('${p.id}')">QR</button>
        <button class="btn-sm danger" onclick="deleteProduct('${p.id}')">✕</button>
      </td>
    </tr>
  `,
      )
      .join("") ||
    `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px">কোনো পণ্য পাওয়া যায়নি</td></tr>`;
}

function toggleSelectAll(cb) {
  document
    .querySelectorAll(".prod-check")
    .forEach((c) => (c.checked = cb.checked));
}

function openProductModal() {
  document.getElementById("productModalTitle").textContent =
    "নতুন পণ্য যোগ করুন";
  document.getElementById("editProductId").value = "";
  document.getElementById("pName").value = "";
  document.getElementById("pCategory").value = "";
  document.getElementById("pSize").value = "";
  document.getElementById("pCost").value = 0;
  document.getElementById("pPrice").value = 0;
  document.getElementById("pStock").value = 1;
  document.getElementById("pCodeType").value = "qr";
  document.getElementById("pCode").value = "";
  document.getElementById("multiSizeMode").checked = false;
  document.querySelectorAll(".msSizeStock").forEach((i) => (i.value = ""));
  onMultiSizeToggle();
  onCodeTypeChange();
  document.getElementById("productModalOverlay").classList.add("show");
}
function closeProductModal() {
  document.getElementById("productModalOverlay").classList.remove("show");
  stopCameraScanner();
}
function onCodeTypeChange() {
  const type = document.getElementById("pCodeType").value;
  const isNew = !document.getElementById("editProductId").value;
  document.getElementById("barcodeScanField").style.display =
    type === "barcode" ? "block" : "none";
  document.getElementById("multiSizeToggleField").style.display =
    type === "qr" && isNew ? "block" : "none";
  if (type === "barcode") {
    document.getElementById("multiSizeMode").checked = false;
    onMultiSizeToggle();
  }
  document.getElementById("qrPreviewBox").innerHTML = "";
}
function onMultiSizeToggle() {
  const isMulti = document.getElementById("multiSizeMode").checked;
  document.getElementById("singleSizeField").style.display = isMulti
    ? "none"
    : "block";
  document.getElementById("singleStockField").style.display = isMulti
    ? "none"
    : "block";
  document.getElementById("multiSizeGrid").style.display = isMulti
    ? "block"
    : "none";
}

function editProduct(id) {
  const p = PRODUCTS_CACHE.find((x) => x.id === id);
  if (!p) return;
  document.getElementById("productModalTitle").textContent = "পণ্য এডিট করুন";
  document.getElementById("editProductId").value = p.id;
  document.getElementById("pName").value = p.name;
  document.getElementById("pCategory").value = p.category || "";
  document.getElementById("pSize").value = p.size || "";
  document.getElementById("pCost").value = p.cost_price;
  document.getElementById("pPrice").value = p.sell_price;
  document.getElementById("pStock").value = p.stock_qty;
  document.getElementById("pCodeType").value = p.code_type;
  document.getElementById("pCode").value = p.code;
  document.getElementById("multiSizeMode").checked = false;
  onMultiSizeToggle();
  onCodeTypeChange();
  document.getElementById("productModalOverlay").classList.add("show");
}

async function saveProduct() {
  const id = document.getElementById("editProductId").value;
  const name = document.getElementById("pName").value.trim();
  if (!name) {
    alert("পণ্যের নাম দিন");
    return;
  }
  const codeType = document.getElementById("pCodeType").value;
  const isMulti =
    !id &&
    codeType === "qr" &&
    document.getElementById("multiSizeMode").checked;

  if (isMulti) {
    const category = document.getElementById("pCategory").value.trim();
    const cost = Number(document.getElementById("pCost").value) || 0;
    const price = Number(document.getElementById("pPrice").value) || 0;
    const sizeInputs = Array.from(document.querySelectorAll(".msSizeStock"))
      .map((i) => ({ size: i.dataset.size, stock: Number(i.value) || 0 }))
      .filter((x) => x.stock > 0);
    if (!sizeInputs.length) {
      alert("অন্তত একটা সাইজে স্টক পরিমাণ দিন");
      return;
    }

    const payloads = sizeInputs.map((s, idx) => ({
      shop_id: CURRENT_SHOP.id,
      name,
      category,
      size: s.size,
      cost_price: cost,
      sell_price: price,
      stock_qty: s.stock,
      code_type: "qr",
      code:
        "QR-" +
        Date.now().toString(36).toUpperCase() +
        "-" +
        idx +
        "-" +
        Math.floor(Math.random() * 900 + 100),
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabaseClient.from("products").insert(payloads);
    if (error) {
      alert("সেভ করতে সমস্যা হয়েছে: " + error.message);
      return;
    }
    closeProductModal();
    await loadProducts();
    return;
  }

  let code = document.getElementById("pCode").value.trim();
  if (codeType === "qr" && !id) {
    code =
      "QR-" +
      Date.now().toString(36).toUpperCase() +
      "-" +
      Math.floor(Math.random() * 900 + 100);
  }
  if (codeType === "barcode" && !code) {
    alert("বারকোড স্ক্যান করুন অথবা টাইপ করুন");
    return;
  }

  const payload = {
    shop_id: CURRENT_SHOP.id,
    name,
    category: document.getElementById("pCategory").value.trim(),
    size: document.getElementById("pSize").value.trim(),
    cost_price: Number(document.getElementById("pCost").value) || 0,
    sell_price: Number(document.getElementById("pPrice").value) || 0,
    stock_qty: Number(document.getElementById("pStock").value) || 0,
    code_type: codeType,
    code,
    updated_at: new Date().toISOString(),
  };

  let error;
  if (id) {
    ({ error } = await supabaseClient
      .from("products")
      .update(payload)
      .eq("id", id));
  } else {
    ({ error } = await supabaseClient.from("products").insert(payload));
  }
  if (error) {
    alert("সেভ করতে সমস্যা হয়েছে: " + error.message);
    return;
  }
  closeProductModal();
  await loadProducts();
}

async function deleteProduct(id) {
  if (!confirm("এই পণ্যটি মুছে ফেলতে চান?")) return;
  await supabaseClient.from("products").delete().eq("id", id);
  await loadProducts();
}

// ---------------------------------------------------------------
// QR GENERATION / LABEL PRINTING
// ---------------------------------------------------------------
function printSingleLabel(id) {
  printLabels([id]);
}
function printSelectedLabels() {
  const ids = Array.from(document.querySelectorAll(".prod-check:checked")).map(
    (c) => c.value,
  );
  if (!ids.length) {
    alert("অন্তত একটি পণ্য নির্বাচন করুন");
    return;
  }
  printLabels(ids);
}
async function printLabels(ids) {
  const items = PRODUCTS_CACHE.filter((p) => ids.includes(p.id));
  const area = document.getElementById("qrPrintArea");

  document.getElementById("printArea").innerHTML = "";

  const shopName = "A.R Fashion House";

  // Label তৈরি
  area.innerHTML =
    '<div class="qr-label-sheet">' +
    items
      .map(
        (p, index) => `
          <div class="qr-label">

            <div class="shop-name top"
              style="
                font-size:21px;
                font-weight:800;
                line-height:1;
                margin-bottom:2px;
                white-space:nowrap;
              ">
              ${shopName}
            </div>

            <div class="prod-price"
              style="
                margin-top:0;
                line-height:1;
              ">
             <span class="mrp-tag" style="font-size:18px;font-weight:800;">M.R.P</span>
             <span style="font-size:20px;font-weight:800;">
              ${Number(p.sell_price).toFixed(0)}
            </div>

            <div class="qr-code-target" data-index="${index}"></div>

          </div>
        `,
      )
      .join("") +
    "</div>";

  // QR Code তৈরি
  const targets = area.querySelectorAll(".qr-code-target");

  for (let i = 0; i < items.length; i++) {
    const p = items[i];

    const canvas = document.createElement("canvas");

    await QRCode.toCanvas(canvas, p.code, {
      width: 88,
      margin: 1,
    });

    targets[i].appendChild(canvas);
  }

  setTimeout(() => window.print(), 200);
}
// ---------------------------------------------------------------
// CAMERA SCANNER (shared by POS + product form)
// ---------------------------------------------------------------
let lastPosScan = { code: "", time: 0 };
function toggleCamScan() {
  scannerTargetMode = "pos";
  const box = document.getElementById("camScanBox");
  if (box.style.display === "block") {
    stopCameraScanner();
    return;
  }
  box.style.display = "block";
  box.innerHTML = '<div id="camReader"></div>';
  lastPosScan = { code: "", time: 0 };
  startCameraScanner("camReader", (text) => {
    const now = Date.now();
    if (text === lastPosScan.code && now - lastPosScan.time < 1500) return; // একই কোড বারবার স্ক্যান হয়ে যাওয়া ঠেকাতে
    lastPosScan = { code: text, time: now };
    handleScannedCode(text);
  });
}
function scanIntoProductForm() {
  scannerTargetMode = "productForm";
  const overlayModal = document.getElementById("productModalOverlay");
  let box = document.getElementById("camScanBoxModal");
  if (box) {
    stopCameraScanner();
    box.remove();
    return;
  }
  box = document.createElement("div");
  box.id = "camScanBoxModal";
  box.innerHTML = '<div id="camReaderModal" style="margin:10px 0;"></div>';
  document.getElementById("barcodeScanField").after(box);
  startCameraScanner("camReaderModal", (text) => {
    document.getElementById("pCode").value = text;
    stopCameraScanner();
    box.remove();
  });
}
function startCameraScanner(elementId, onResult) {
  stopCameraScanner();
  html5QrInstance = new Html5Qrcode(elementId);
  const config = { fps: 10, qrbox: { width: 220, height: 220 } };
  html5QrInstance
    .start({ facingMode: "environment" }, config, (decodedText) => {
      onResult(decodedText);
    })
    .catch(() => {
      alert("ক্যামেরা চালু করা যায়নি। ব্রাউজারে ক্যামেরা পারমিশন দিন।");
    });
}
function stopCameraScanner() {
  if (html5QrInstance) {
    html5QrInstance
      .stop()
      .then(() => html5QrInstance.clear())
      .catch(() => {});
    html5QrInstance = null;
  }
  document.getElementById("camScanBox").style.display = "none";
}

// ---------------------------------------------------------------
// POS / CART
// ---------------------------------------------------------------
function handleScannedCode(code) {
  if (!code) return;
  const product = PRODUCTS_CACHE.find((p) => p.code === code);
  if (!product) {
    alert("এই কোডের কোনো পণ্য পাওয়া যায়নি: " + code);
    document.getElementById("scanInput").focus();
    return;
  }
  addToCart(product);
  document.getElementById("scanInput").focus();
}

function addToCart(product) {
  const existing = CART.find((c) => c.product_id === product.id);
  if (existing) {
    if (existing.qty + 1 > product.stock_qty) {
      alert("স্টকে পর্যাপ্ত মাল নেই");
      return;
    }
    existing.qty += 1;
  } else {
    if (product.stock_qty < 1) {
      alert("স্টক শেষ");
      return;
    }
    CART.push({
      product_id: product.id,
      name: product.name,
      code: product.code,
      qty: 1,
      price: Number(product.sell_price),
      original_price: Number(product.sell_price),
      stock_qty: product.stock_qty,
    });
  }
  renderCart();
}

function updateCartQty(productId, qty) {
  const item = CART.find((c) => c.product_id === productId);
  if (!item) return;
  qty = Math.max(1, Math.min(Number(qty) || 1, item.stock_qty));
  item.qty = qty;
  renderCart();
}
function updateCartPrice(productId, price) {
  const item = CART.find((c) => c.product_id === productId);
  if (!item) return;
  item.price = Math.max(0, Number(price) || 0);
  renderCart();
}
function removeFromCart(productId) {
  CART = CART.filter((c) => c.product_id !== productId);
  renderCart();
}

function onPaymentMethodChange() {
  const isDue = document.getElementById("paymentMethod").value === "due";
  document.getElementById("advancePaidField").style.display = isDue
    ? "block"
    : "none";
  if (!isDue) document.getElementById("advancePaid").value = 0;
  renderCart();
}

function renderCart() {
  const list = document.getElementById("cartList");
  const emptyMsg = document.getElementById("emptyCartMsg");
  emptyMsg.style.display = CART.length ? "none" : "block";
  list.innerHTML = CART.map(
    (c) => `
    <div class="cart-row">
      <div class="name">${escapeHtml(c.name)}
        <small>একক দাম: ৳<input type="number" value="${c.price}" min="0" style="width:64px;padding:2px 4px;border:1px solid var(--border);border-radius:5px;" onchange="updateCartPrice('${c.product_id}', this.value)"> ${c.price !== c.original_price ? `<span style="color:var(--warn)">(আগে ৳${c.original_price})</span>` : ""}</small>
      </div>
      <input type="number" min="1" value="${c.qty}" onchange="updateCartQty('${c.product_id}', this.value)">
      <strong>৳${(c.price * c.qty).toFixed(0)}</strong>
      <button class="rm" onclick="removeFromCart('${c.product_id}')">✕</button>
    </div>
  `,
  ).join("");

  const subtotal = CART.reduce((s, c) => s + c.price * c.qty, 0);
  const discType = document.getElementById("discountType").value;
  const discVal = Number(document.getElementById("discountValue").value) || 0;
  const discountAmount = Math.min(
    subtotal,
    discType === "percent" ? (subtotal * discVal) / 100 : discVal,
  );
  const total = Math.max(0, subtotal - discountAmount);

  document.getElementById("sumSubtotal").textContent =
    "৳" + subtotal.toFixed(0);

  const isDue = document.getElementById("paymentMethod").value === "due";
  if (isDue) {
    const advance = Math.min(
      total,
      Number(document.getElementById("advancePaid").value) || 0,
    );
    const dueLeft = total - advance;
    document.getElementById("sumTotal").innerHTML =
      `৳${total.toFixed(0)} <span style="font-size:13px;color:var(--danger);display:block;">এর মধ্যে বাকি থাকবে ৳${dueLeft.toFixed(0)}</span>`;
  } else {
    document.getElementById("sumTotal").textContent = "৳" + total.toFixed(0);
  }
}

async function checkout() {
  if (!CART.length) {
    alert("কার্টে কোনো পণ্য নেই");
    return;
  }
  const subtotal = CART.reduce((s, c) => s + c.price * c.qty, 0);
  const discType = document.getElementById("discountType").value;
  const discVal = Number(document.getElementById("discountValue").value) || 0;
  const discountAmount = Math.min(
    subtotal,
    discType === "percent" ? (subtotal * discVal) / 100 : discVal,
  );
  const total = Math.max(0, subtotal - discountAmount);
  const paymentMethod = document.getElementById("paymentMethod").value;
  const custName = document.getElementById("custName").value.trim();
  const custPhone = document.getElementById("custPhone").value.trim();

  let dueLeft = 0;
  if (paymentMethod === "due") {
    if (!custName || !custPhone) {
      alert("বাকিতে বিক্রি করতে গ্রাহকের নাম ও মোবাইল নাম্বার দিতে হবে");
      return;
    }
    const advance = Math.min(
      total,
      Number(document.getElementById("advancePaid").value) || 0,
    );
    dueLeft = total - advance;
  }

  const { data: invoiceNo, error: invErr } =
    await supabaseClient.rpc("next_invoice_no");
  if (invErr) {
    alert("ইনভয়েস নাম্বার তৈরি করা যায়নি: " + invErr.message);
    return;
  }

  const items = CART.map((c) => ({
    product_id: c.product_id,
    name: c.name,
    code: c.code,
    qty: c.qty,
    price: c.price,
    line_total: c.price * c.qty,
  }));

  let customerId = null;
  if (paymentMethod === "due" && dueLeft > 0) {
    customerId = await findOrCreateCustomer(custName, custPhone);
    if (!customerId) {
      alert("গ্রাহকের তথ্য সংরক্ষণ করা যায়নি");
      return;
    }
  }

  const { data: saleRow, error: saleErr } = await supabaseClient
    .from("sales")
    .insert({
      shop_id: CURRENT_SHOP.id,
      invoice_no: invoiceNo,
      items,
      subtotal,
      discount_total: discountAmount,
      total,
      payment_method: paymentMethod,
      customer_name: custName,
      customer_phone: custPhone,
      customer_id: customerId,
      created_by: CURRENT_USER.id,
    })
    .select()
    .single();
  if (saleErr) {
    alert("বিক্রি সংরক্ষণ করতে সমস্যা: " + saleErr.message);
    return;
  }

  for (const c of CART) {
    const prod = PRODUCTS_CACHE.find((p) => p.id === c.product_id);
    if (prod)
      await supabaseClient
        .from("products")
        .update({ stock_qty: prod.stock_qty - c.qty })
        .eq("id", c.product_id);
  }

  if (customerId && dueLeft > 0) {
    await supabaseClient.from("ledger_entries").insert({
      shop_id: CURRENT_SHOP.id,
      customer_id: customerId,
      type: "বাকি",
      amount: dueLeft,
      note: "মেমো " + invoiceNo + " থেকে বাকি",
      sale_id: saleRow.id,
      created_by: CURRENT_USER.id,
    });
    const cust = CUSTOMERS_CACHE.find((c) => c.id === customerId);
    const newDue = (cust ? Number(cust.due_amount) : 0) + dueLeft;
    await supabaseClient
      .from("customers")
      .update({ due_amount: newDue })
      .eq("id", customerId);
  }

  printMemo({
    invoiceNo,
    items,
    subtotal,
    discountAmount,
    total,
    dueLeft,
    payment: paymentMethod,
    custName,
    custPhone,
    format: document.getElementById("printFormat").value,
  });

  CART = [];
  document.getElementById("discountValue").value = 0;
  document.getElementById("advancePaid").value = 0;
  document.getElementById("custName").value = "";
  document.getElementById("custPhone").value = "";
  renderCart();
  await loadProducts();
  await loadCustomers();
  document.getElementById("scanInput").focus();
}

async function findOrCreateCustomer(name, phone) {
  let existing = CUSTOMERS_CACHE.find((c) => c.phone === phone);
  if (existing) return existing.id;
  const { data, error } = await supabaseClient
    .from("customers")
    .insert({
      shop_id: CURRENT_SHOP.id,
      name,
      phone,
      due_amount: 0,
    })
    .select()
    .single();
  if (error) return null;
  CUSTOMERS_CACHE.push(data);
  return data.id;
}

function printMemo(sale) {
  const now = new Date();
  const dateStr = now.toLocaleString("bn-BD");
  const shopName = CURRENT_SHOP?.name || "দোকান";
  const shopAddr = CURRENT_SHOP?.address || "";
  const area = document.getElementById("printArea");

  document.getElementById("qrPrintArea").innerHTML = "";

  const logoImg = CURRENT_SHOP?.logo_url
    ? `<img src="${CURRENT_SHOP.logo_url}" style="width:48px;height:48px;object-fit:cover;border-radius:8px;display:block;margin:0 auto 4px;">`
    : "";
  const logoImgA4 = CURRENT_SHOP?.logo_url
    ? `<img src="${CURRENT_SHOP.logo_url}" style="width:64px;height:64px;object-fit:cover;border-radius:10px;float:right;">`
    : "";
  const dueLine =
    sale.dueLeft > 0
      ? `<div style="font-weight:bold;color:#c0392b">বাকি রইলো: ৳${sale.dueLeft.toFixed(0)}</div>`
      : "";
  const dueLineA4 =
    sale.dueLeft > 0
      ? `<span style="color:#c0392b"><br>বাকি রইলো: ৳${sale.dueLeft.toFixed(0)}</span>`
      : "";

  if (sale.format === "thermal") {
    area.innerHTML = `
      <div class="memo-thermal">
        ${logoImg}
        <h2>${escapeHtml(shopName)}</h2>
        <div class="center">${escapeHtml(shopAddr)}</div>
        <hr>
        <div>মেমো: ${sale.invoiceNo}</div>
        <div>তারিখ: ${dateStr}</div>
        ${sale.custName ? `<div>গ্রাহক: ${escapeHtml(sale.custName)} ${sale.custPhone ? "- " + escapeHtml(sale.custPhone) : ""}</div>` : ""}
        <hr>
        <table>
          <tr><th>পণ্য</th><th>পরিঃ</th><th>দাম</th></tr>
          ${sale.items.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td>${i.qty}</td><td>${i.line_total.toFixed(0)}</td></tr>`).join("")}
        </table>
        <hr>
        <div>সাবটোটাল: ৳${sale.subtotal.toFixed(0)}</div>
        <div>ডিসকাউন্ট: ৳${sale.discountAmount.toFixed(0)}</div>
        <div style="font-weight:bold;font-size:14px">সর্বমোট: ৳${sale.total.toFixed(0)}</div>
        <div>পেমেন্ট: ${paymentLabel(sale.payment)}</div>
        ${dueLine}
        <hr>
        <div class="center">ধন্যবাদ, আবার আসবেন!</div>
      </div>`;
  } else {
    area.innerHTML = `
      <div class="memo-a4">
        ${logoImgA4}
        <h1>${escapeHtml(shopName)}</h1>
        <div>${escapeHtml(shopAddr)}</div>
        <div style="clear:both"></div>
        <hr>
        <p><strong>মেমো নং:</strong> ${sale.invoiceNo} &nbsp;&nbsp; <strong>তারিখ:</strong> ${dateStr}</p>
        ${sale.custName ? `<p><strong>গ্রাহক:</strong> ${escapeHtml(sale.custName)} ${sale.custPhone ? "- " + escapeHtml(sale.custPhone) : ""}</p>` : ""}
        <table>
          <thead><tr><th>পণ্য</th><th>পরিমাণ</th><th>একক দাম</th><th>মোট</th></tr></thead>
          <tbody>${sale.items.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td>${i.qty}</td><td>৳${i.price.toFixed(0)}</td><td>৳${i.line_total.toFixed(0)}</td></tr>`).join("")}</tbody>
        </table>
        <p style="text-align:right;margin-top:14px">
          সাবটোটাল: ৳${sale.subtotal.toFixed(0)}<br>
          ডিসকাউন্ট: ৳${sale.discountAmount.toFixed(0)}<br>
          <strong style="font-size:18px">সর্বমোট: ৳${sale.total.toFixed(0)}</strong>${dueLineA4}<br>
          পেমেন্ট: ${paymentLabel(sale.payment)}
        </p>
        <p>ধন্যবাদান্তে, আবার আসবেন!</p>
      </div>`;
  }
  setTimeout(() => window.print(), 200);
}
function paymentLabel(p) {
  return (
    {
      cash: "নগদ",
      bkash: "বিকাশ",
      nagad: "নগদ (Nagad)",
      card: "কার্ড",
      due: "বাকি",
    }[p] || p
  );
}

// ---------------------------------------------------------------
// DASHBOARD
// ---------------------------------------------------------------
async function loadDashboard() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { data: sales } = await supabaseClient
    .from("sales")
    .select("*")
    .gte("created_at", today.toISOString())
    .order("created_at", { ascending: false });

  const totalSales = (sales || []).reduce((s, x) => s + Number(x.total), 0);
  const totalDiscount = (sales || []).reduce(
    (s, x) => s + Number(x.discount_total),
    0,
  );
  document.getElementById("statTodaySales").textContent =
    "৳" + totalSales.toFixed(0);
  document.getElementById("statTodayInvoices").textContent = (
    sales || []
  ).length;
  document.getElementById("statTodayDiscount").textContent =
    "৳" + totalDiscount.toFixed(0);
  document.getElementById("statLowStock").textContent = PRODUCTS_CACHE.filter(
    (p) => p.stock_qty <= 5,
  ).length;

  document.getElementById("recentSalesBody").innerHTML =
    (sales || [])
      .slice(0, 10)
      .map(
        (s) => `
    <tr>
      <td>${s.invoice_no}</td>
      <td>${new Date(s.created_at).toLocaleTimeString("bn-BD", { hour: "2-digit", minute: "2-digit" })}</td>
      <td>${s.items.length} টি</td>
      <td>৳${Number(s.total).toFixed(0)}</td>
      <td>${paymentLabel(s.payment_method)}</td>
    </tr>
  `,
      )
      .join("") ||
    `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:16px">আজ এখনো কোনো বিক্রি হয়নি</td></tr>`;
}

// ---------------------------------------------------------------
// DAY REPORT
// ---------------------------------------------------------------
async function loadDayReport() {
  const dateVal = document.getElementById("reportDate").value;
  if (!dateVal) return;
  const start = new Date(dateVal);
  start.setHours(0, 0, 0, 0);
  const end = new Date(dateVal);
  end.setHours(23, 59, 59, 999);

  const { data: sales } = await supabaseClient
    .from("sales")
    .select("*")
    .gte("created_at", start.toISOString())
    .lte("created_at", end.toISOString())
    .order("created_at", { ascending: true });

  const list = sales || [];
  const totalSales = list.reduce((s, x) => s + Number(x.total), 0);
  const totalDiscount = list.reduce((s, x) => s + Number(x.discount_total), 0);
  const byPayment = {};
  list.forEach(
    (s) =>
      (byPayment[s.payment_method] =
        (byPayment[s.payment_method] || 0) + Number(s.total)),
  );

  document.getElementById("reportStats").innerHTML = `
    <div class="stat green"><div class="num">৳${totalSales.toFixed(0)}</div><div class="label">মোট বিক্রি</div></div>
    <div class="stat blue"><div class="num">${list.length}</div><div class="label">মোট মেমো</div></div>
    <div class="stat orange"><div class="num">৳${totalDiscount.toFixed(0)}</div><div class="label">মোট ডিসকাউন্ট</div></div>
    <div class="stat red"><div class="num">৳${(byPayment.cash || 0).toFixed(0)}</div><div class="label">নগদ আদায়</div></div>
  `;

  document.getElementById("reportBody").innerHTML =
    list
      .map(
        (s) => `
    <tr>
      <td>${s.invoice_no}</td>
      <td>${new Date(s.created_at).toLocaleTimeString("bn-BD", { hour: "2-digit", minute: "2-digit" })}</td>
      <td>${escapeHtml(s.customer_name || "-")}</td>
      <td>${s.items.length} টি</td>
      <td>৳${Number(s.discount_total).toFixed(0)}</td>
      <td>৳${Number(s.total).toFixed(0)}</td>
      <td>${paymentLabel(s.payment_method)}</td>
    </tr>
  `,
      )
      .join("") ||
    `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:16px">এই দিনে কোনো বিক্রি নেই</td></tr>`;
}

let invoiceSearchTimer = null;
function searchAllInvoices() {
  clearTimeout(invoiceSearchTimer);
  const q = document.getElementById("invoiceSearch").value.trim();
  if (!q) {
    document.getElementById("searchResultsCard").style.display = "none";
    return;
  }
  invoiceSearchTimer = setTimeout(async () => {
    const { data } = await supabaseClient
      .from("sales")
      .select("*")
      .or(
        `invoice_no.ilike.%${q}%,customer_name.ilike.%${q}%,customer_phone.ilike.%${q}%`,
      )
      .order("created_at", { ascending: false })
      .limit(30);
    const card = document.getElementById("searchResultsCard");
    card.style.display = "block";
    document.getElementById("searchResultsBody").innerHTML =
      (data || [])
        .map(
          (s) => `
      <tr>
        <td>${s.invoice_no}</td>
        <td>${new Date(s.created_at).toLocaleDateString("bn-BD")}</td>
        <td>${escapeHtml(s.customer_name || "-")}</td>
        <td>৳${Number(s.total).toFixed(0)}</td>
        <td>${paymentLabel(s.payment_method)}</td>
        <td><button class="btn-sm gray" onclick='reprintSale(${JSON.stringify(s).replace(/'/g, "&#39;")})'>🖨️ রিপ্রিন্ট</button></td>
      </tr>
    `,
        )
        .join("") ||
      `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:14px">কিছু পাওয়া যায়নি</td></tr>`;
  }, 350);
}

function reprintSale(s) {
  printMemo({
    invoiceNo: s.invoice_no,
    items: s.items,
    subtotal: Number(s.subtotal),
    discountAmount: Number(s.discount_total),
    total: Number(s.total),
    dueLeft: 0,
    payment: s.payment_method,
    custName: s.customer_name,
    custPhone: s.customer_phone,
    format: "thermal",
  });
}

function printDayReport() {
  const dateVal = document.getElementById("reportDate").value;
  const area = document.getElementById("printArea");
  area.innerHTML = `<div class="memo-a4"><h1>${escapeHtml(CURRENT_SHOP?.name || "দোকান")} — দিনের হিসাব</h1><p>তারিখ: ${dateVal}</p>${document.getElementById("reportStats").outerHTML}${document.querySelector("#page-report table").outerHTML}</div>`;
  setTimeout(() => window.print(), 200);
}

// ---------------------------------------------------------------
// বাকির খাতা (CUSTOMERS / LEDGER)
// ---------------------------------------------------------------
async function loadCustomers() {
  const { data } = await supabaseClient
    .from("customers")
    .select("*")
    .order("created_at", { ascending: true });
  CUSTOMERS_CACHE = data || [];
}

function renderLedger() {
  const search = document.getElementById("ledgerSearch").value.toLowerCase();
  const sort = document.getElementById("ledgerSort").value;
  const minDue = Number(document.getElementById("ledgerMinDue").value) || null;
  const maxDue = Number(document.getElementById("ledgerMaxDue").value) || null;

  let list = CUSTOMERS_CACHE.filter((c) => c.due_amount > 0 || search);
  if (search)
    list = list.filter(
      (c) =>
        c.name.toLowerCase().includes(search) ||
        (c.phone || "").includes(search),
    );
  if (minDue !== null)
    list = list.filter((c) => Number(c.due_amount) >= minDue);
  if (maxDue !== null)
    list = list.filter((c) => Number(c.due_amount) <= maxDue);

  if (sort === "due_desc")
    list = [...list].sort(
      (a, b) => Number(b.due_amount) - Number(a.due_amount),
    );
  if (sort === "old")
    list = [...list].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at),
    );
  if (sort === "new")
    list = [...list].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );

  const totalDue = CUSTOMERS_CACHE.reduce(
    (s, c) => s + Number(c.due_amount),
    0,
  );
  const customersWithDue = CUSTOMERS_CACHE.filter(
    (c) => c.due_amount > 0,
  ).length;
  document.getElementById("ledgerStats").innerHTML = `
    <div class="stat red"><div class="num">৳${totalDue.toFixed(0)}</div><div class="label">মোট বাকি</div></div>
    <div class="stat orange"><div class="num">${customersWithDue}</div><div class="label">বাকি আছে এমন গ্রাহক</div></div>
    <div class="stat blue"><div class="num">${CUSTOMERS_CACHE.length}</div><div class="label">মোট গ্রাহক</div></div>
    <div class="stat green"><div class="num">৳${(totalDue / Math.max(1, customersWithDue)).toFixed(0)}</div><div class="label">গড় বাকি/গ্রাহক</div></div>
  `;

  document.getElementById("ledgerBody").innerHTML =
    list
      .map(
        (c) => `
    <tr onclick="openCustomerDetail('${c.id}')" style="cursor:pointer">
      <td><strong>${escapeHtml(c.name)}</strong></td>
      <td>${escapeHtml(c.phone || "-")}</td>
      <td><span class="badge ${c.due_amount > 0 ? "low" : "ok"}">৳${Number(c.due_amount).toFixed(0)}</span></td>
      <td><button class="btn-sm gray" onclick="event.stopPropagation();openCustomerDetail('${c.id}')">বিস্তারিত</button></td>
    </tr>
  `,
      )
      .join("") ||
    `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:20px">কোনো গ্রাহক পাওয়া যায়নি</td></tr>`;
}

function openNewCustomerModal() {
  document.getElementById("ncName").value = "";
  document.getElementById("ncPhone").value = "";
  document.getElementById("ncAddress").value = "";
  document.getElementById("ncInitialDue").value = 0;
  document.getElementById("ncDate").valueAsDate = new Date();
  document.getElementById("customerModalOverlay").classList.add("show");
}
function closeNewCustomerModal() {
  document.getElementById("customerModalOverlay").classList.remove("show");
}
async function saveNewCustomer() {
  const name = document.getElementById("ncName").value.trim();
  const phone = document.getElementById("ncPhone").value.trim();
  if (!name) {
    alert("গ্রাহকের নাম দিন");
    return;
  }
  const initialDue = Number(document.getElementById("ncInitialDue").value) || 0;
  const entryDate = document.getElementById("ncDate").value;

  const { data, error } = await supabaseClient
    .from("customers")
    .insert({
      shop_id: CURRENT_SHOP.id,
      name,
      phone,
      address: document.getElementById("ncAddress").value.trim(),
      due_amount: initialDue,
      created_at: entryDate
        ? new Date(entryDate).toISOString()
        : new Date().toISOString(),
    })
    .select()
    .single();
  if (error) {
    alert("সংরক্ষণ করতে সমস্যা: " + error.message);
    return;
  }

  if (initialDue > 0) {
    await supabaseClient.from("ledger_entries").insert({
      shop_id: CURRENT_SHOP.id,
      customer_id: data.id,
      type: "বাকি",
      amount: initialDue,
      note: "শুরুর বাকি",
      created_by: CURRENT_USER.id,
      entry_date: entryDate
        ? new Date(entryDate).toISOString()
        : new Date().toISOString(),
    });
  }
  closeNewCustomerModal();
  await loadCustomers();
  renderLedger();
}

async function openCustomerDetail(id) {
  activeCustomerId = id;
  const c = CUSTOMERS_CACHE.find((x) => x.id === id);
  if (!c) return;
  document.getElementById("cdName").textContent = c.name;
  document.getElementById("cdPhone").textContent =
    (c.phone || "") + (c.address ? " — " + c.address : "");
  document.getElementById("cdDueAmount").textContent =
    "৳" + Number(c.due_amount).toFixed(0);
  document.getElementById("ledgerEntryForm").style.display = "none";
  document.getElementById("customerDetailOverlay").classList.add("show");

  const { data: history } = await supabaseClient
    .from("ledger_entries")
    .select("*")
    .eq("customer_id", id)
    .order("entry_date", { ascending: false });
  document.getElementById("cdHistoryBody").innerHTML =
    (history || [])
      .map(
        (h) => `
    <tr>
      <td>${new Date(h.entry_date).toLocaleDateString("bn-BD")}</td>
      <td><span class="badge ${h.type === "জমা" ? "ok" : "low"}">${h.type}</span></td>
      <td>৳${Number(h.amount).toFixed(0)}</td>
      <td style="color:var(--muted);font-size:12.5px">${escapeHtml(h.note || "")}</td>
    </tr>
  `,
      )
      .join("") ||
    `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:14px">কোনো লেনদেন নেই</td></tr>`;
}
function closeCustomerDetail() {
  document.getElementById("customerDetailOverlay").classList.remove("show");
  activeCustomerId = null;
}

let pendingLedgerType = null;
function openLedgerEntryForm(type) {
  pendingLedgerType = type;
  document.getElementById("ledgerEntryForm").style.display = "block";
  document.getElementById("ledgerEntryLabel").textContent =
    type === "জমা" ? "কত টাকা জমা নিচ্ছেন" : "কত টাকার বাকি দিচ্ছেন";
  document.getElementById("ledgerEntryAmount").value = 0;
  document.getElementById("ledgerEntryDate").valueAsDate = new Date();
  document.getElementById("ledgerEntryNote").value = "";
}

async function submitLedgerEntry() {
  const amount =
    Number(document.getElementById("ledgerEntryAmount").value) || 0;
  if (amount <= 0) {
    alert("সঠিক পরিমাণ দিন");
    return;
  }
  const entryDate = document.getElementById("ledgerEntryDate").value;
  const note = document.getElementById("ledgerEntryNote").value.trim();
  const c = CUSTOMERS_CACHE.find((x) => x.id === activeCustomerId);
  if (!c) return;

  await supabaseClient.from("ledger_entries").insert({
    shop_id: CURRENT_SHOP.id,
    customer_id: c.id,
    type: pendingLedgerType,
    amount,
    note,
    created_by: CURRENT_USER.id,
    entry_date: entryDate
      ? new Date(entryDate).toISOString()
      : new Date().toISOString(),
  });

  const newDue =
    pendingLedgerType === "জমা"
      ? Math.max(0, Number(c.due_amount) - amount)
      : Number(c.due_amount) + amount;
  await supabaseClient
    .from("customers")
    .update({ due_amount: newDue })
    .eq("id", c.id);

  await loadCustomers();
  openCustomerDetail(c.id);
  renderLedger();
}

// ---------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------
async function saveShopSettings() {
  const name = document.getElementById("settingsShopName").value.trim();
  const address = document.getElementById("settingsShopAddr").value.trim();
  const payload = { name, address };
  if (pendingLogoDataUrl) payload.logo_url = pendingLogoDataUrl;
  const { error } = await supabaseClient
    .from("shops")
    .update(payload)
    .eq("id", CURRENT_SHOP.id);
  if (error) {
    alert("সংরক্ষণ করতে সমস্যা হয়েছে: " + error.message);
    return;
  }
  CURRENT_SHOP.name = name;
  CURRENT_SHOP.address = address;
  if (pendingLogoDataUrl) {
    CURRENT_SHOP.logo_url = pendingLogoDataUrl;
    pendingLogoDataUrl = null;
  }
  document.getElementById("shopNameDisplay").textContent = name;
  applyLogoToUI(CURRENT_SHOP.logo_url);
  alert("সংরক্ষিত হয়েছে");
}

// ---------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        m
      ],
  );
}
