const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const current = new Date();
const state = {
  page: "dashboard",
  month: current.getMonth() + 1,
  year: current.getFullYear(),
  categories: [],
  expenses: [],
  budgets: [],
  expense: null,
  salary: null,
  hasSalaryRecords: false,
  savings: null,
};
const currency = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const categoryIcons = ["◉", "↗", "✧", "▤", "✚", "♫", "✳", "◇", "☼", "⌁"];
let sessionToken = sessionStorage.getItem("pocket-session");
localStorage.removeItem("pocket-session");
let authMode = "login";
let searchTimer;
let toastTimer;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function money(value) {
  return currency.format(Number(value) || 0);
}

function dateLabel(value) {
  if (!value) return "—";
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function currentMonthLabel() {
  return `${monthNames[state.month - 1]} ${state.year}`;
}

function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.toggle("error", isError);
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("show"), 3000);
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  $("#auth-heading").textContent = registering ? "Create your account" : "Welcome back";
  $("#auth-subheading").textContent = registering
    ? "Create a private tracker for your personal finances."
    : "Sign in to continue to your personal expense tracker.";
  $("#auth-login-form").classList.toggle("hidden", registering);
  $("#auth-register-form").classList.toggle("hidden", !registering);
  $$(".auth-tab").forEach((tab) => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $("#auth-message").textContent = "";
}

function showAuth(message = "") {
  $("#app-shell").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  $("#auth-message").textContent = message;
}

function showApplication(user) {
  $("#auth-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  $(".profile strong").textContent = user.user_id;
  $(".profile div:nth-child(2) span").textContent = "Personal account";
  const initial = user.user_id.charAt(0).toUpperCase();
  $(".avatar").textContent = initial;
  $("#account-menu-button").textContent = initial;
  $("#account-avatar-large").textContent = initial;
  $("#account-user-id").textContent = user.user_id;
}

function setAccountPopoverOpen(open) {
  $("#account-popover").classList.toggle("hidden", !open);
  $("#account-menu-button").setAttribute("aria-expanded", String(open));
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Can't reach the tracker API. Start it from the project folder with: uvicorn backend.main:app --reload");
    }
    throw error;
  }
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") {
        message = body.detail;
      } else if (Array.isArray(body.detail)) {
        message = body.detail.map((item) => item.msg).filter(Boolean).join(" ");
      }
    } catch {
      // Keep the HTTP status message when the server response is not JSON.
    }
    const error = new Error(message);
    error.status = response.status;
    if (response.status === 401 && sessionToken && !path.startsWith("/auth/")) {
      sessionToken = null;
      sessionStorage.removeItem("pocket-session");
      showAuth(message);
    }
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function queryMonth() {
  return `?month=${state.month}&year=${state.year}`;
}

function categoryPill(name, color) {
  return `<span class="category-pill"><i class="dot" style="background:${escapeHtml(color || "#91a0b5")}"></i>${escapeHtml(name)}</span>`;
}

function expenseIcon(category, color) {
  const index = Math.max(0, state.categories.findIndex((item) => item.name === category));
  return `<span class="expense-symbol" style="background:${escapeHtml(color || "#91a0b5")}20;color:${escapeHtml(color || "#91a0b5")}">${categoryIcons[index % categoryIcons.length]}</span>`;
}

function expenseRow(expense, actions = true) {
  return `<tr>
    <td><div class="expense-name">${expenseIcon(expense.category, expense.category_color)}<span>${escapeHtml(expense.title)}</span></div></td>
    <td>${categoryPill(expense.category, expense.category_color)}</td>
    <td>${dateLabel(expense.date)}</td>
    <td class="amount-cell">${money(expense.amount)}</td>
    <td>${actions ? `<div class="row-actions"><button class="row-action" data-action="view-expense" data-id="${expense.id}" aria-label="View ${escapeHtml(expense.title)}">↗</button><button class="row-action" data-action="edit-expense" data-id="${expense.id}" aria-label="Edit ${escapeHtml(expense.title)}">✎</button></div>` : ""}</td>
  </tr>`;
}

function setEmptyTable(tbody, columns, message) {
  tbody.innerHTML = `<tr><td class="empty-row" colspan="${columns}">${escapeHtml(message)}</td></tr>`;
}

function navigate(page) {
  state.page = page;
  $$(".page-view").forEach((section) => section.classList.toggle("hidden", section.id !== `page-${page}`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  const labels = { dashboard: "Dashboard", expenses: "Expenses", budgets: "Budgets", categories: "Categories", reports: "Reports" };
  $("#breadcrumb-page").textContent = labels[page];
  loadPage(page).catch((error) => toast(error.message, true));
}

async function loadCategories() {
  state.categories = await api("/categories");
  const filter = $("#category-filter");
  const selected = filter.value;
  filter.innerHTML = `<option value="">All categories</option>${state.categories.map((category) => `<option value="${escapeHtml(category.name)}">${escapeHtml(category.name)}</option>`).join("")}`;
  filter.value = state.categories.some((category) => category.name === selected) ? selected : "";
}

async function loadPage(page) {
  if (page === "dashboard") return loadDashboard();
  if (page === "expenses") return loadExpenses();
  if (page === "budgets") return loadBudgets();
  if (page === "categories") return renderCategories();
  if (page === "reports") return loadReports();
}

async function loadDashboard() {
  const [data, trends] = await Promise.all([
    api(`/dashboard${queryMonth()}`),
    api(`/trends${queryMonth()}&periods=6`),
  ]);
  state.salary = data.salary;
  state.hasSalaryRecords = data.has_salary_records;
  state.savings = data.savings;
  $("#stat-spent").textContent = money(data.spent);
  $("#stat-salary").textContent = data.salary === null ? "—" : money(data.salary);
  $("#salary-foot").textContent = data.salary === null ? "Set salary for this month" : "Edit this month's salary";
  $("#stat-savings").textContent = data.savings === null ? "—" : money(data.savings);
  $("#savings-foot").textContent = data.savings === null ? "Set monthly savings" : "Edit monthly savings";
  $("#stat-remaining").textContent = data.salary_remaining === null ? "—" : money(data.salary_remaining);
  $("#stat-count").textContent = data.expense_count;
  $("#donut-total").textContent = money(data.spent);
  $("#budget-spent").textContent = money(data.budgeted_spent);
  $("#budget-total").textContent = money(data.budget);
  $("#remaining-foot").textContent = data.salary_remaining === null
    ? "Set your monthly salary to see what's left"
    : data.salary_remaining < 0 ? `${money(Math.abs(data.salary_remaining))} over salary after spending and savings` : "Salary minus spending and savings";
  const budgetUsage = data.budget > 0 ? data.budgeted_spent / data.budget : null;
  const actualPercentage = budgetUsage === null ? null : Math.round(budgetUsage * 100);
  const percentage = actualPercentage === null ? null : Math.min(actualPercentage, 100);
  $("#budget-percent").textContent = percentage === null ? "—" : `${percentage}%`;
  $("#budget-percent-label").textContent = percentage === null ? "no budget" : "used";
  $("#budget-circle").style.background = `conic-gradient(${actualPercentage > 100 ? "var(--coral)" : "var(--purple)"} ${(percentage || 0) * 3.6}deg, var(--line) 0deg)`;
  $("#budget-circle").setAttribute(
    "aria-label",
    percentage === null
      ? "No category budgets set"
      : `${actualPercentage}% of category budgets used; progress display capped at 100%`,
  );
  $("#budget-status").textContent = percentage === null
    ? `${money(data.spent)} spent; set category budgets to track progress.`
    : actualPercentage > 100
      ? `${money(data.budgeted_spent - data.budget)} over budget (${actualPercentage}% used)${data.unbudgeted_spent > 0 ? ` · ${money(data.unbudgeted_spent)} in unbudgeted categories` : ""}`
      : `${money(data.budget - data.budgeted_spent)} remaining across budgeted categories${data.unbudgeted_spent > 0 ? ` · ${money(data.unbudgeted_spent)} in unbudgeted categories` : ""}`;
  $("#budget-status").classList.toggle("over-budget", actualPercentage > 100);
  const palette = data.categories.length ? data.categories : [];
  if (palette.length) {
    let cursor = 0;
    const stops = palette.map((item) => {
      const start = cursor;
      cursor += item.spent / data.spent * 100;
      return `${item.color} ${start}% ${cursor}%`;
    });
    $("#dashboard-donut").style.background = `conic-gradient(${stops.join(", ")})`;
    $("#dashboard-legend").innerHTML = palette.map((item) =>
      `<div class="legend-item"><i class="dot" style="background:${escapeHtml(item.color)}"></i><span>${escapeHtml(item.name)}</span><strong>${money(item.spent)}${data.salary ? ` <small>${(item.spent / data.salary * 100).toFixed(1)}%</small>` : ""}</strong></div>`
    ).join("");
  } else {
    $("#dashboard-donut").style.background = "conic-gradient(var(--line) 0 100%)";
    $("#dashboard-legend").innerHTML = '<div class="empty-note">Add expenses to see your spending breakdown.</div>';
  }
  const recentBody = $("#recent-body");
  recentBody.innerHTML = data.recent_expenses.length
    ? data.recent_expenses.map((item) => expenseRow(item)).join("")
    : "";
  if (!data.recent_expenses.length) setEmptyTable(recentBody, 5, "No expenses yet. Add your first expense to get started.");
  renderTrends(trends);
}

function renderTrends(trends) {
  const maximum = Math.max(...trends.flatMap((item) => [item.salary || 0, item.spent, item.savings || 0]), 1);
  $("#trend-chart").innerHTML = trends.map((item) => {
    const salaryHeight = item.salary === null ? 0 : Math.max(item.salary / maximum * 100, 2);
    const spentHeight = item.spent > 0 ? Math.max(item.spent / maximum * 100, 2) : 0;
    const savingsHeight = item.savings === null ? 0 : Math.max(item.savings / maximum * 100, 2);
    return `<div class="trend-group">
      <div class="trend-bars">
        <span class="trend-bar trend-bar-income" style="height:${salaryHeight}%" title="${item.salary === null ? "Salary not set" : `${item.label} salary: ${money(item.salary)}`}"></span>
        <span class="trend-bar trend-bar-spent" style="height:${spentHeight}%" title="${item.label} spent: ${money(item.spent)}"></span>
        <span class="trend-bar trend-bar-savings" style="height:${savingsHeight}%" title="${item.savings === null ? "Savings not set" : `${item.label} saved: ${money(item.savings)}`}"></span>
      </div>
      <span class="trend-month">${escapeHtml(item.label)} '${String(item.year).slice(-2)}</span>
    </div>`;
  }).join("");
}

async function loadExpenses() {
  const params = new URLSearchParams();
  const search = $("#expense-search").value.trim();
  const category = $("#category-filter").value;
  const from = $("#date-from").value;
  const to = $("#date-to").value;
  if (search) params.set("search", search);
  if (category) params.set("category", category);
  if (from) params.set("date_from", from);
  if (to) params.set("date_to", to);
  state.expenses = await api(`/expenses${params.size ? `?${params.toString()}` : ""}`);
  const body = $("#expenses-body");
  body.innerHTML = state.expenses.map((item) => expenseRow(item)).join("");
  if (!state.expenses.length) setEmptyTable(body, 5, "No expenses match these filters.");
  $("#expense-count-label").textContent = `${state.expenses.length} ${state.expenses.length === 1 ? "expense" : "expenses"}`;
}

async function loadBudgets() {
  state.budgets = await api(`/budgets${queryMonth()}`);
  const total = state.budgets.reduce((sum, item) => sum + item.amount, 0);
  const spent = state.budgets.reduce((sum, item) => sum + item.spent, 0);
  $("#budget-month-label").textContent = `Your category limits for ${currentMonthLabel()}`;
  $("#budget-summary-cards").innerHTML = [
    ["Total budget", money(total), currentMonthLabel()],
    ["Amount spent", money(spent), `${state.budgets.length} ${state.budgets.length === 1 ? "category" : "categories"} budgeted`],
    ["Remaining", money(total - spent), spent > total ? "You are over your budget" : "Available to spend"],
  ].map(([label, amount, foot]) => `<div class="mini-stat"><span>${label}</span><strong>${amount}</strong><small>${foot}</small></div>`).join("");
  const body = $("#budgets-body");
  body.innerHTML = state.budgets.map((item) => {
    const percentage = item.amount > 0 ? Math.round(item.spent / item.amount * 100) : 0;
    return `<tr>
      <td>${categoryPill(item.category, item.color)}</td><td>${monthNames[item.month - 1]} ${item.year}</td>
      <td class="amount-cell">${money(item.spent)}</td><td class="amount-cell">${money(item.amount)}</td>
      <td><div style="display:flex;align-items:center;gap:8px;min-width:100px"><div class="progress-track"><div class="progress-fill ${percentage > 100 ? "over" : ""}" style="width:${Math.min(percentage, 100)}%"></div></div><span style="font-size:9px;color:var(--muted)">${percentage}%</span></div></td>
      <td><div class="row-actions"><button class="row-action" data-action="delete-budget" data-id="${item.id}" aria-label="Delete ${escapeHtml(item.category)} budget">×</button></div></td>
    </tr>`;
  }).join("");
  if (!state.budgets.length) setEmptyTable(body, 6, "No budgets for this month. Add a budget to start planning.");
}

async function renderCategories() {
  const categories = state.categories;
  $("#category-grid").innerHTML = categories.length ? categories.map((category, index) =>
    `<article class="category-card"><button class="category-open" data-action="view-category-history" data-id="${category.id}" aria-label="View all history for ${escapeHtml(category.name)}"><span class="category-swatch" style="background:${escapeHtml(category.color)}20;color:${escapeHtml(category.color)}">${categoryIcons[index % categoryIcons.length]}</span><span class="category-info"><strong>${escapeHtml(category.name)}</strong><span>${category.expense_count} ${category.expense_count === 1 ? "expense" : "expenses"}</span><span class="category-history-hint">View all expenses & budgets →</span></span></button><button class="row-action" data-action="delete-category" data-id="${category.id}" aria-label="Delete ${escapeHtml(category.name)} category">×</button></article>`
  ).join("") : '<div class="empty-note">No categories yet.</div>';
}

async function openCategoryHistory(categoryId) {
  const result = await api(`/categories/${categoryId}/history`);
  const { category, history, expenses } = result;
  const content = `<div class="budget-history-summary">
      <div><span>All-time budgeted</span><strong>${money(result.total_budgeted)}</strong></div>
      <div><span>All-time category spending</span><strong>${money(result.total_spent)}</strong></div>
    </div>
    <h3 class="history-section-title">Monthly budget history</h3>
    ${history.length ? `<div class="table-wrap budget-history-table"><table>
      <thead><tr><th>MONTH</th><th>SPENT</th><th>BUDGET</th><th>REMAINING</th><th>USED</th></tr></thead>
      <tbody>${history.map((item) => {
        const remaining = item.amount - item.spent;
        const percentage = item.amount > 0 ? Math.round(item.spent / item.amount * 100) : 0;
        return `<tr>
          <td>${monthNames[item.month - 1]} ${item.year}</td>
          <td class="amount-cell">${money(item.spent)}</td>
          <td class="amount-cell">${money(item.amount)}</td>
          <td class="amount-cell ${remaining < 0 ? "amount-over" : ""}">${money(remaining)}</td>
          <td><span class="history-percent ${percentage > 100 ? "over" : ""}">${percentage}%</span></td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>` : '<div class="history-empty">No budgets have been set for this category yet.</div>'}
    <h3 class="history-section-title">All expenses</h3>
    ${expenses.length ? `<div class="table-wrap budget-history-table"><table>
      <thead><tr><th>EXPENSE</th><th>DATE</th><th>AMOUNT</th></tr></thead>
      <tbody>${expenses.map((item) => `<tr>
        <td><strong>${escapeHtml(item.title)}</strong>${item.description ? `<small class="history-description">${escapeHtml(item.description)}</small>` : ""}</td>
        <td>${dateLabel(item.date)}</td><td class="amount-cell">${money(item.amount)}</td>
      </tr>`).join("")}</tbody>
    </table></div>` : '<div class="history-empty">No expenses have been recorded for this category yet.</div>'}
    <div class="modal-actions"><button class="button button-outline" data-action="close-modal">Close</button><button class="button button-primary" data-action="add-category-budget" data-category="${escapeHtml(category.name)}">＋ Add budget for ${escapeHtml(category.name)}</button></div>`;
  openModal(`${category.name} history`, content, "CATEGORY HISTORY");
}

async function loadReports() {
  const report = await api(`/reports${queryMonth()}`);
  const remaining = report.total_budget - report.total_spent;
  const salaryRemaining = report.salary_remaining;
  $("#report-stats").innerHTML = [
    ["Monthly salary", report.salary === null ? "—" : money(report.salary), report.salary === null ? "Set salary from the dashboard" : currentMonthLabel()],
    ["Total spent", money(report.total_spent), report.salary ? `${(report.total_spent / report.salary * 100).toFixed(1)}% of salary` : currentMonthLabel()],
    ["Monthly savings", report.savings === null ? "—" : money(report.savings), report.savings === null ? "Set monthly savings" : report.salary ? `${(report.savings / report.salary * 100).toFixed(1)}% of salary` : currentMonthLabel()],
    ["Salary remaining", salaryRemaining === null ? "—" : money(salaryRemaining), salaryRemaining === null ? "Add salary for this month" : salaryRemaining < 0 ? "Spending and savings exceed salary" : "Salary minus spending and savings"],
  ].map(([label, amount, foot]) => `<div class="mini-stat"><span>${label}</span><strong>${amount}</strong><small>${foot}</small></div>`).join("");
  const maximum = Math.max(...report.daily.map((item) => item.total), 1);
  $("#daily-chart").innerHTML = report.daily.length ? report.daily.map((item) => {
    const day = Number(item.date.slice(8, 10));
    const height = Math.max(item.total / maximum * 100, 3);
    const label = `${dateLabel(item.date)}: ${money(item.total)}`;
    return `<div class="bar-column" role="img" tabindex="0" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" data-tooltip="${escapeHtml(money(item.total))}"><div class="bar" style="--bar-height:${height}%;height:${height}%"></div><span class="bar-label">${day}</span></div>`;
  }).join("") : '<div class="empty-note">No daily spending to show for this month.</div>';
  $("#report-categories").innerHTML = report.categories.length ? report.categories.map((item) => {
    const cap = item.budget > 0 ? item.budget : Math.max(item.spent, 1);
    const percentage = item.budget > 0 ? Math.round(item.spent / item.budget * 100) : 0;
    const salaryShare = report.salary ? `${(item.spent / report.salary * 100).toFixed(1)}% of salary` : "";
    return `<div class="report-category-row"><div class="report-row-top"><span>${categoryPill(item.category, item.color)}</span><strong>${money(item.spent)}${item.budget ? ` / ${money(item.budget)}` : ""}</strong></div><div class="progress-track"><div class="progress-fill ${item.spent > item.budget && item.budget > 0 ? "over" : ""}" style="width:${Math.min(item.spent / cap * 100, 100)}%;background:${item.spent > item.budget && item.budget > 0 ? "var(--coral)" : escapeHtml(item.color)}"></div></div>${item.budget || salaryShare ? `<small style="display:block;margin-top:6px;color:var(--muted);font-size:9px">${item.budget ? `${percentage}% of budget` : ""}${item.budget && salaryShare ? " · " : ""}${salaryShare}</small>` : ""}</div>`;
  }).join("") : '<div class="empty-note" style="margin-top:22px">Add expenses to see your category report.</div>';
}

function openModal(title, content, eyebrow = "YOUR MONEY, YOUR WAY") {
  $("#modal-title").textContent = title;
  $("#modal-eyebrow").textContent = eyebrow;
  $("#modal-content").innerHTML = content;
  $("#modal-backdrop").classList.remove("hidden");
  const firstInput = $("#modal-content input, #modal-content select");
  if (firstInput) firstInput.focus();
}

function closeModal() {
  $("#modal-backdrop").classList.add("hidden");
  state.expense = null;
}

function categoryOptions(selected = "") {
  return state.categories.map((category) =>
    `<option value="${escapeHtml(category.name)}" ${category.name === selected ? "selected" : ""}>${escapeHtml(category.name)}</option>`
  ).join("");
}

function openExpenseForm(expense = null) {
  state.expense = expense;
  const today = new Date();
  const date = expense?.date || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const content = `<form id="expense-form">
    <div class="form-grid">
      <div class="field full"><label for="expense-title">Title</label><input id="expense-title" name="title" maxlength="120" required placeholder="e.g. Weekly groceries" value="${escapeHtml(expense?.title || "")}" /></div>
      <div class="field"><label for="expense-amount">Amount (₹)</label><input id="expense-amount" name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00" value="${expense ? escapeHtml(expense.amount) : ""}" /></div>
      <div class="field"><label for="expense-category">Category</label><select id="expense-category" name="category" required>${categoryOptions(expense?.category || state.categories[0]?.name || "")}</select></div>
      <div class="field full"><label for="expense-date">Date</label><input id="expense-date" name="date" type="date" required value="${date}" /></div>
      <div class="field full"><label for="expense-description">Description <span style="color:#a0a1ad;font-weight:400">(optional)</span></label><textarea id="expense-description" name="description" maxlength="1000" placeholder="Add a note about this expense...">${escapeHtml(expense?.description || "")}</textarea></div>
    </div>
    <div class="modal-actions"><button class="button button-outline" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">${expense ? "Save changes" : "Save expense"}</button></div>
  </form>`;
  openModal(expense ? "Edit expense" : "Add an expense", content);
}

function openBudgetForm(category = "") {
  const content = `<form id="budget-form"><div class="form-grid">
    <div class="field full"><label for="budget-category">Category</label><select id="budget-category" name="category" required>${categoryOptions(category)}</select></div>
    <div class="field"><label for="budget-amount">Monthly amount (₹)</label><input id="budget-amount" name="amount" type="number" min="0.01" step="0.01" required placeholder="0.00" /></div>
    <div class="field"><label for="budget-month">Month</label><select id="budget-month" name="month">${monthNames.map((name, index) => `<option value="${index + 1}" ${index + 1 === state.month ? "selected" : ""}>${name}</option>`).join("")}</select></div>
    <div class="field full"><label for="budget-year">Year</label><input id="budget-year" name="year" type="number" min="1900" max="9999" required value="${state.year}" /></div>
  </div><div class="modal-actions"><button class="button button-outline" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Save budget</button></div></form>`;
  openModal("Create a budget", content);
}

function openSalaryForm() {
  const resetConfirmation = state.hasSalaryRecords
    ? `<div class="field full reset-warning"><p>Setting salary again will permanently clear all expenses, budgets, salaries, and savings from every month in this account. Your account and categories will remain.</p><label class="reset-confirmation"><input name="reset_account_data" type="checkbox" value="true" required /><span>I understand. Clear all my old financial data and start fresh.</span></label></div>`
    : "";
  const content = `<form id="salary-form"><div class="form-grid">
    <div class="field full"><label for="salary-amount">Take-home salary (₹) for ${escapeHtml(currentMonthLabel())}</label><input id="salary-amount" name="amount" type="number" min="0.01" step="0.01" required placeholder="e.g. 45000" value="${state.salary === null ? "" : escapeHtml(state.salary)}" /></div>
    <div class="field"><label for="salary-month">Month</label><select id="salary-month" name="month">${monthNames.map((name, index) => `<option value="${index + 1}" ${index + 1 === state.month ? "selected" : ""}>${name}</option>`).join("")}</select></div>
    <div class="field"><label for="salary-year">Year</label><input id="salary-year" name="year" type="number" min="1900" max="9999" required value="${state.year}" /></div>
    ${resetConfirmation}
  </div><div class="modal-actions"><button class="button button-outline" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Save salary</button></div></form>`;
  openModal("Set your monthly salary", content, "PLAN YOUR MONTH");
}

function openSavingsForm() {
  const content = `<form id="savings-form"><div class="form-grid">
    <div class="field full"><label for="savings-amount">Monthly savings (₹) for ${escapeHtml(currentMonthLabel())}</label><input id="savings-amount" name="amount" type="number" min="0" step="0.01" required placeholder="e.g. 5000" value="${state.savings === null ? "" : escapeHtml(state.savings)}" /><small class="form-help">Enter the amount you really put aside this month. This is tracked separately from salary remaining.</small></div>
    <div class="field"><label for="savings-month">Month</label><select id="savings-month" name="month">${monthNames.map((name, index) => `<option value="${index + 1}" ${index + 1 === state.month ? "selected" : ""}>${name}</option>`).join("")}</select></div>
    <div class="field"><label for="savings-year">Year</label><input id="savings-year" name="year" type="number" min="1900" max="9999" required value="${state.year}" /></div>
  </div><div class="modal-actions"><button class="button button-outline" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Save monthly savings</button></div></form>`;
  openModal("Monthly savings", content, "YOUR MONTHLY SAVINGS");
}

function openCategoryForm() {
  const content = `<form id="category-form"><div class="form-grid">
    <div class="field full"><label for="category-name">Category name</label><input id="category-name" name="name" maxlength="60" required placeholder="e.g. Travel" /></div>
    <div class="field full"><label for="category-color">Category color</label><input id="category-color" name="color" type="color" value="#91a0b5" /></div>
  </div><div class="modal-actions"><button class="button button-outline" type="button" data-action="close-modal">Cancel</button><button class="button button-primary" type="submit">Add category</button></div></form>`;
  openModal("Create a category", content);
}

async function openExpenseDetails(id) {
  const expense = await api(`/expenses/${id}`);
  state.expense = expense;
  const content = `<div class="detail-amount">${money(expense.amount)}</div>
    <div class="detail-grid"><div class="detail-item"><span>Title</span><strong>${escapeHtml(expense.title)}</strong></div><div class="detail-item"><span>Category</span><strong>${categoryPill(expense.category, expense.category_color)}</strong></div><div class="detail-item"><span>Date</span><strong>${dateLabel(expense.date)}</strong></div><div class="detail-item"><span>Amount</span><strong>${money(expense.amount)}</strong></div></div>
    <p class="detail-description">${escapeHtml(expense.description || "No description added.")}</p>
    <div class="modal-actions"><button class="button button-outline" data-action="delete-expense" data-id="${expense.id}">Delete</button><button class="button button-outline" data-action="close-modal">Close</button><button class="button button-primary" data-action="edit-expense" data-id="${expense.id}">Edit expense</button></div>`;
  openModal("Expense details", content, "TRANSACTION");
}

async function refreshCurrentAndDashboard() {
  await loadCategories();
  await loadDashboard();
  if (state.page !== "dashboard") await loadPage(state.page);
}

async function handleSubmit(event) {
  const form = event.target;
  if (!form.matches("form")) return;
  event.preventDefault();
  if (form.id === "auth-login-form" || form.id === "auth-register-form") {
    const registering = form.id === "auth-register-form";
    const values = Object.fromEntries(new FormData(form).entries());
    let result;
    try {
      result = await api(registering ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: JSON.stringify(values),
      });
    } catch (error) {
      showAuth(error.message);
      return;
    }
    sessionToken = result.access_token;
    sessionStorage.setItem("pocket-session", sessionToken);
    showApplication(result.user);
    try {
      await loadCategories();
      await loadDashboard();
      toast(registering ? "Your account is ready." : "You are signed in.");
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  const values = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.id === "expense-form") {
      const editing = Boolean(state.expense);
      const payload = { ...values, amount: Number(values.amount) };
      await api(editing ? `/expenses/${state.expense.id}` : "/expenses", {
        method: editing ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      closeModal();
      toast(editing ? "Expense updated." : "Expense added.");
    } else if (form.id === "budget-form") {
      await api("/budgets", {
        method: "POST",
        body: JSON.stringify({ ...values, amount: Number(values.amount), month: Number(values.month), year: Number(values.year) }),
      });
      closeModal();
      toast("Budget added.");
    } else if (form.id === "salary-form") {
      const month = Number(values.month);
      const year = Number(values.year);
      const resetAccountData = values.reset_account_data === "true";
      await api("/salary", {
        method: "PUT",
        body: JSON.stringify({
          amount: Number(values.amount),
          month,
          year,
          reset_account_data: resetAccountData,
        }),
      });
      state.month = month;
      state.year = year;
      $("#month-picker").value = `${year}-${String(month).padStart(2, "0")}`;
      closeModal();
      toast(resetAccountData ? "Account financial data cleared. New salary saved." : "Monthly salary saved.");
    } else if (form.id === "savings-form") {
      const month = Number(values.month);
      const year = Number(values.year);
      await api("/savings", {
        method: "PUT",
        body: JSON.stringify({ amount: Number(values.amount), month, year }),
      });
      state.month = month;
      state.year = year;
      $("#month-picker").value = `${year}-${String(month).padStart(2, "0")}`;
      closeModal();
      toast("Monthly savings saved.");
    } else if (form.id === "category-form") {
      await api("/categories", { method: "POST", body: JSON.stringify(values) });
      closeModal();
      toast("Category added.");
    }
    await refreshCurrentAndDashboard();
  } catch (error) {
    toast(error.message, true);
  }
}

function downloadReport() {
  api(`/reports${queryMonth()}`).then((report) => {
    const rows = [
      ["Category", "Spent (INR)", "Budget (INR)", "Share of salary (%)", "Monthly salary (INR)", "Monthly savings (INR)", "Salary remaining (INR)", "Month", "Year"],
      ["Monthly summary", report.total_spent, report.total_budget, "", report.salary ?? "", report.savings ?? "", report.salary_remaining ?? "", report.month, report.year],
      ...report.categories.map((item) => [item.category, item.spent, item.budget, report.salary ? (item.spent / report.salary * 100).toFixed(2) : "", "", "", "", report.month, report.year]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = `pocket-report-${report.year}-${String(report.month).padStart(2, "0")}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }).catch((error) => toast(error.message, true));
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button, a[data-page]");
  if (!button) return;
  if (button.dataset.page) {
    event.preventDefault();
    navigate(button.dataset.page);
    return;
  }
  const action = button.dataset.action;
  if (!action) return;
  const id = Number(button.dataset.id);
  try {
    if (action === "add-expense") openExpenseForm();
    if (action === "add-budget") openBudgetForm();
    if (action === "view-category-history") await openCategoryHistory(id);
    if (action === "add-category-budget") {
      const category = button.dataset.category;
      closeModal();
      openBudgetForm(category);
    }
    if (action === "set-salary") openSalaryForm();
    if (action === "set-savings") openSavingsForm();
    if (action === "add-category") openCategoryForm();
    if (action === "close-modal") closeModal();
    if (action === "view-expense") await openExpenseDetails(id);
    if (action === "edit-expense") {
      const expense = state.expense?.id === id ? state.expense : await api(`/expenses/${id}`);
      openExpenseForm(expense);
    }
    if (action === "delete-expense") {
      if (!confirm("Delete this expense? This action cannot be undone.")) return;
      await api(`/expenses/${id}`, { method: "DELETE" });
      closeModal();
      toast("Expense deleted.");
      await refreshCurrentAndDashboard();
    }
    if (action === "delete-budget") {
      if (!confirm("Delete this budget?")) return;
      await api(`/budgets/${id}`, { method: "DELETE" });
      toast("Budget deleted.");
      await refreshCurrentAndDashboard();
    }
    if (action === "delete-category") {
      if (!confirm("Delete this category? Categories used by an expense or budget cannot be deleted.")) return;
      await api(`/categories/${id}`, { method: "DELETE" });
      toast("Category deleted.");
      await refreshCurrentAndDashboard();
    }
    if (action === "clear-filters") {
      $("#expense-search").value = "";
      $("#category-filter").value = "";
      $("#date-from").value = "";
      $("#date-to").value = "";
      await loadExpenses();
    }
  } catch (error) {
    toast(error.message, true);
  }
});

document.addEventListener("submit", handleSubmit);
$("#modal-close").addEventListener("click", closeModal);
$("#modal-backdrop").addEventListener("click", (event) => {
  if (event.target === $("#modal-backdrop")) closeModal();
});
$("#month-picker").addEventListener("change", async (event) => {
  if (!event.target.value) return;
  [state.year, state.month] = event.target.value.split("-").map(Number);
  try {
    await loadPage(state.page);
  } catch (error) {
    toast(error.message, true);
  }
});
$("#expense-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadExpenses().catch((error) => toast(error.message, true)), 220);
});
["#category-filter", "#date-from", "#date-to"].forEach((selector) => {
  $(selector).addEventListener("change", () => loadExpenses().catch((error) => toast(error.message, true)));
});
$("#top-search-button").addEventListener("click", () => {
  navigate("expenses");
  setTimeout(() => $("#expense-search").focus(), 0);
});
$("#account-menu-button").addEventListener("click", () => {
  const isOpen = $("#account-menu-button").getAttribute("aria-expanded") === "true";
  setAccountPopoverOpen(!isOpen);
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".account-menu")) setAccountPopoverOpen(false);
});
$("#download-report").addEventListener("click", downloadReport);
$$(".auth-tab").forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.authMode)));
$("#logout-button").addEventListener("click", async () => {
  let message = "You have signed out.";
  let isError = false;
  try {
    await api("/auth/logout", { method: "POST" });
  } catch (error) {
    message = `Signed out on this device, but the server could not end the session: ${error.message}`;
    isError = true;
  }
  sessionToken = null;
  sessionStorage.removeItem("pocket-session");
  setAuthMode("login");
  showAuth();
  toast(message, isError);
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    navigate("expenses");
    setTimeout(() => $("#expense-search").focus(), 0);
  }
  if (event.key === "Escape") {
    closeModal();
    setAccountPopoverOpen(false);
  }
});

$("#month-picker").value = `${state.year}-${String(state.month).padStart(2, "0")}`;
$("#today-label").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }).toUpperCase();
async function initializeApplication() {
  if (!sessionToken) {
    showAuth();
    return;
  }
  try {
    const user = await api("/auth/me");
    showApplication(user);
    await loadCategories();
    await loadDashboard();
  } catch (error) {
    if (error.status === 401) {
      sessionToken = null;
      sessionStorage.removeItem("pocket-session");
    }
    showAuth(error.message);
  }
}
initializeApplication();
