# Pocket Expense & Budget Tracker

A small expense and monthly budget tracker with a responsive HTML/CSS/JavaScript interface, a FastAPI REST API, and a local SQLite database.

## Run locally

1. Create and activate a Python virtual environment.
2. Install the dependencies: `pip install -r requirements.txt`
3. Start the application from the project root: `uvicorn backend.main:app --reload`
4. Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Interactive API documentation is at `/docs`.

For deployment platforms configured with `uvicorn main:app` or `uvicorn demo:app`, the root `main.py` and `demo.py` re-export the FastAPI app from `backend/main.py`. Run the command from the project root, where `requirements.txt` is located.

The SQLite database is created at `backend/expense_tracker.db` on first startup. Set `EXPENSE_TRACKER_DB` to use a different database file. On startup, the built-in `Food & Dining` category is renamed to `Food & Drinks` in existing databases, preserving associated expenses and budgets.

## Features

- Register a personal account or sign in with a user ID/email and password; each account has private expense, budget, salary, savings, and category data
- Dashboard with monthly salary, spending, monthly savings, salary remaining, budget progress, category breakdown, six-month income/spending/savings trends, and recent expenses
- Create, view, edit, delete, search, and filter expenses by category and date range
- Create and remove categories; a category in use by an expense or budget cannot be removed
- Open a category to view its complete expense history and month-by-month budget history, including spend and remaining amount
- Add and remove category budgets by month and year, with category-level spent and remaining progress
- Set a take-home salary; confirming a later salary reset clears prior financial records for that account
- Set one monthly savings amount for each month/year; revise it without conflating it with salary remaining
- Monthly reports with category and daily breakdowns, salary shares, savings, and CSV export
- Six-month salary, spending, and savings history at `/api/trends`
- API endpoints under `/api`; FastAPI validates inputs and persists data in SQLite

All amounts are displayed in Indian rupees (INR). Existing saved amounts are not converted; values are shown as rupees at the same numeric amount. Salary and budget records are specific to a month and year.

Passwords are stored as salted PBKDF2 hashes, and server-side sign-in sessions expire after seven days. The browser keeps the sign-in token only for the current tab, so reloading that tab stays signed in but opening the app in a new tab requires signing in again. Every registered account receives a separate SQLite database file with its own expenses, budgets, categories, salary, and savings; new accounts start with only the built-in starter categories, never another account's financial records. Existing accounts that previously used the shared database are migrated to individual files while preserving their data. Any pre-login legacy records with no existing account owner stay in the original database and are not automatically assigned to the first new account. Keep all database files private and back them up together.

When setting a salary after a salary has already been saved in the account, confirm the reset checkbox to clear that account's expenses, budgets, salaries, and savings across all months before saving the new salary. This reset is permanent; the account and its categories remain.

The default setup is for local use. If exposing the app on a network, serve it behind HTTPS and keep the SQLite database files inaccessible to other users.
