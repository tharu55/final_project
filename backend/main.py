from __future__ import annotations

import calendar
import hashlib
import hmac
import os
import secrets
import sqlite3
import time
import uuid
from contextvars import ContextVar
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime
from pathlib import Path
from typing import Any, Generator

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR.parent / "static"
DATABASE_PATH = Path(os.getenv("EXPENSE_TRACKER_DB", BASE_DIR / "expense_tracker.db"))
SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7
PASSWORD_HASH_ITERATIONS = 310_000
_request_database_path: ContextVar[Path | None] = ContextVar("request_database_path", default=None)
DEFAULT_CATEGORIES = [
    ("Food & Drinks", "#f09a63"),
    ("Transport", "#7a9ef3"),
    ("Shopping", "#b48bea"),
    ("Bills & Utilities", "#e2bd61"),
    ("Health", "#70b9a5"),
    ("Entertainment", "#e47e91"),
    ("Other", "#91a0b5"),
]


@contextmanager
def connect_db(database_path: Path | None = None) -> Generator[sqlite3.Connection, None, None]:
    path = database_path or _request_database_path.get() or DATABASE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize_data_database(
    database_path: Path,
    migrate_legacy_category: bool = False,
    seed_categories: bool = True,
) -> None:
    with connect_db(database_path) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                color TEXT NOT NULL DEFAULT '#91a0b5'
            );
            CREATE TABLE IF NOT EXISTS expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                amount REAL NOT NULL CHECK (amount > 0),
                category TEXT NOT NULL REFERENCES categories(name)
                    ON UPDATE CASCADE ON DELETE RESTRICT,
                date TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS budgets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL REFERENCES categories(name)
                    ON UPDATE CASCADE ON DELETE RESTRICT,
                amount REAL NOT NULL CHECK (amount > 0),
                month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
                year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 9999),
                UNIQUE(category, month, year)
            );
            CREATE TABLE IF NOT EXISTS monthly_salaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                amount REAL NOT NULL CHECK (amount > 0),
                month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
                year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 9999),
                UNIQUE(month, year)
            );
            CREATE TABLE IF NOT EXISTS monthly_savings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                amount REAL NOT NULL CHECK (amount >= 0),
                month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
                year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 9999),
                UNIQUE(month, year)
            );
            """
        )
        if migrate_legacy_category:
            legacy_category = connection.execute(
                "SELECT id FROM categories WHERE name = ? COLLATE NOCASE",
                ("Food & Dining",),
            ).fetchone()
            renamed_category = connection.execute(
                "SELECT id FROM categories WHERE name = ? COLLATE NOCASE",
                ("Food & Drinks",),
            ).fetchone()
            if legacy_category and not renamed_category:
                connection.execute(
                    "UPDATE categories SET name = ? WHERE id = ?",
                    ("Food & Drinks", legacy_category["id"]),
                )
        if seed_categories:
            connection.executemany(
                "INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)",
                DEFAULT_CATEGORIES,
            )


def initialize_database() -> None:
    initialize_data_database(
        DATABASE_PATH,
        migrate_legacy_category=True,
        seed_categories=False,
    )
    with connect_db(DATABASE_PATH) as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                database_key TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            """
        )
    migrate_default_account_databases()


@asynccontextmanager
async def lifespan(_: FastAPI):
    initialize_database()
    yield


app = FastAPI(title="Pocket Budget API", version="1.0.0", lifespan=lifespan)


class ExpenseInput(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    amount: float = Field(gt=0, allow_inf_nan=False)
    category: str = Field(min_length=1, max_length=60)
    date: date
    description: str = Field(default="", max_length=1000)


class BudgetInput(BaseModel):
    category: str = Field(min_length=1, max_length=60)
    amount: float = Field(gt=0, allow_inf_nan=False)
    month: int = Field(ge=1, le=12)
    year: int = Field(ge=1900, le=9999)


class SalaryInput(BaseModel):
    amount: float = Field(gt=0, allow_inf_nan=False)
    month: int = Field(ge=1, le=12)
    year: int = Field(ge=1900, le=9999)
    reset_account_data: bool = False


class SavingsInput(BaseModel):
    amount: float = Field(ge=0, allow_inf_nan=False)
    month: int = Field(ge=1, le=12)
    year: int = Field(ge=1900, le=9999)


class CategoryInput(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    color: str = Field(default="#91a0b5", pattern=r"^#[0-9a-fA-F]{6}$")


class RegistrationInput(BaseModel):
    user_id: str = Field(
        min_length=3,
        max_length=40,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._@+-]*$",
    )
    password: str = Field(min_length=8, max_length=128)


class LoginInput(BaseModel):
    user_id: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=128)


def row_dict(row: sqlite3.Row) -> dict[str, Any]:
    return dict(row)


def user_database_path(database_key: str) -> Path:
    return DATABASE_PATH.with_name(f"{DATABASE_PATH.stem}_{database_key}{DATABASE_PATH.suffix}")


def migrate_default_account_databases() -> None:
    with connect_db(DATABASE_PATH) as connection:
        legacy_accounts = connection.execute(
            "SELECT id FROM accounts WHERE database_key = 'default'"
        ).fetchall()
    for account in legacy_accounts:
        database_key = uuid.uuid4().hex
        target_path = user_database_path(database_key)
        initialize_data_database(target_path, seed_categories=False)
        with connect_db(DATABASE_PATH) as source:
            categories = source.execute("SELECT id, name, color FROM categories").fetchall()
            expenses = source.execute(
                "SELECT id, title, amount, category, date, description FROM expenses"
            ).fetchall()
            budgets = source.execute(
                "SELECT id, category, amount, month, year FROM budgets"
            ).fetchall()
            salaries = source.execute(
                "SELECT id, amount, month, year FROM monthly_salaries"
            ).fetchall()
            savings = source.execute(
                "SELECT id, amount, month, year FROM monthly_savings"
            ).fetchall()
        with connect_db(target_path) as target:
            target.executemany(
                "INSERT INTO categories (id, name, color) VALUES (?, ?, ?)",
                [tuple(row) for row in categories],
            )
            target.executemany(
                """
                INSERT INTO expenses (id, title, amount, category, date, description)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [tuple(row) for row in expenses],
            )
            target.executemany(
                "INSERT INTO budgets (id, category, amount, month, year) VALUES (?, ?, ?, ?, ?)",
                [tuple(row) for row in budgets],
            )
            target.executemany(
                "INSERT INTO monthly_salaries (id, amount, month, year) VALUES (?, ?, ?, ?)",
                [tuple(row) for row in salaries],
            )
            target.executemany(
                "INSERT INTO monthly_savings (id, amount, month, year) VALUES (?, ?, ?, ?)",
                [tuple(row) for row in savings],
            )
        with connect_db(DATABASE_PATH) as connection:
            connection.execute(
                "UPDATE accounts SET database_key = ? WHERE id = ? AND database_key = 'default'",
                (database_key, account["id"]),
            )


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PASSWORD_HASH_ITERATIONS,
    )
    return f"pbkdf2_sha256${PASSWORD_HASH_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded_hash: str) -> bool:
    try:
        algorithm, iterations, salt_hex, expected_digest = encoded_hash.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        actual_digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            bytes.fromhex(salt_hex),
            int(iterations),
        ).hex()
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual_digest, expected_digest)


def create_session(connection: sqlite3.Connection, account_id: int) -> str:
    token = secrets.token_urlsafe(32)
    connection.execute(
        "INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
        (
            hashlib.sha256(token.encode("utf-8")).hexdigest(),
            account_id,
            int(time.time()) + SESSION_DURATION_SECONDS,
        ),
    )
    return token


@app.middleware("http")
async def authenticate_api_request(request: Request, call_next):
    path = request.url.path
    if not path.startswith("/api/") or path in {
        "/api/health",
        "/api/auth/login",
        "/api/auth/register",
    }:
        return await call_next(request)

    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return JSONResponse(status_code=401, content={"detail": "Sign in to access the tracker."})

    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with connect_db(DATABASE_PATH) as connection:
        session = connection.execute(
            """
            SELECT s.account_id, s.expires_at, a.user_id, a.database_key
            FROM sessions s JOIN accounts a ON a.id = s.account_id
            WHERE s.token_hash = ?
            """,
            (token_hash,),
        ).fetchone()
        if session and session["expires_at"] <= int(time.time()):
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
            session = None
    if not session:
        return JSONResponse(status_code=401, content={"detail": "Your session expired. Please sign in again."})

    request.state.account_id = session["account_id"]
    request.state.user_id = session["user_id"]
    request.state.token_hash = token_hash
    database_token = _request_database_path.set(user_database_path(session["database_key"]))
    try:
        return await call_next(request)
    finally:
        _request_database_path.reset(database_token)


@app.post("/api/auth/register", status_code=201)
def register(payload: RegistrationInput) -> dict[str, Any]:
    user_id = payload.user_id.strip()
    password_hash = hash_password(payload.password)
    now = int(time.time())
    try:
        with connect_db(DATABASE_PATH) as connection:
            connection.execute("BEGIN IMMEDIATE")
            database_key = uuid.uuid4().hex
            initialize_data_database(user_database_path(database_key))
            cursor = connection.execute(
                """
                INSERT INTO accounts (user_id, password_hash, database_key, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (user_id, password_hash, database_key, now),
            )
            token = create_session(connection, cursor.lastrowid)
            account = {"user_id": user_id}
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="That user ID is already registered.") from error
    return {"access_token": token, "token_type": "bearer", "user": account}


@app.post("/api/auth/login")
def login(payload: LoginInput) -> dict[str, Any]:
    with connect_db(DATABASE_PATH) as connection:
        account = connection.execute(
            "SELECT id, user_id, password_hash FROM accounts WHERE user_id = ? COLLATE NOCASE",
            (payload.user_id.strip(),),
        ).fetchone()
        if not account or not verify_password(payload.password, account["password_hash"]):
            raise HTTPException(status_code=401, detail="Invalid user ID or password.")
        token = create_session(connection, account["id"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {"user_id": account["user_id"]},
    }


@app.get("/api/auth/me")
def current_account(request: Request) -> dict[str, str]:
    return {"user_id": request.state.user_id}


@app.post("/api/auth/logout", status_code=204)
def logout(request: Request) -> Response:
    with connect_db(DATABASE_PATH) as connection:
        connection.execute("DELETE FROM sessions WHERE token_hash = ?", (request.state.token_hash,))
    return Response(status_code=204)


def require_category(connection: sqlite3.Connection, category: str) -> None:
    exists = connection.execute(
        "SELECT 1 FROM categories WHERE name = ? COLLATE NOCASE", (category.strip(),)
    ).fetchone()
    if not exists:
        raise HTTPException(status_code=422, detail="Choose an existing category.")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/categories")
def list_categories() -> list[dict[str, Any]]:
    with connect_db() as connection:
        rows = connection.execute(
            """
            SELECT c.id, c.name, c.color, COUNT(e.id) AS expense_count
            FROM categories c
            LEFT JOIN expenses e ON e.category = c.name
            GROUP BY c.id
            ORDER BY c.name COLLATE NOCASE
            """
        ).fetchall()
    return [row_dict(row) for row in rows]


@app.get("/api/categories/{category_id}/history")
def category_history(category_id: int) -> dict[str, Any]:
    with connect_db() as connection:
        category = connection.execute(
            "SELECT id, name, color FROM categories WHERE id = ?", (category_id,)
        ).fetchone()
        if not category:
            raise HTTPException(status_code=404, detail="Category not found.")
        rows = connection.execute(
            """
            SELECT b.id, b.amount, b.month, b.year, c.name AS category, c.color,
                COALESCE(SUM(CASE
                    WHEN CAST(substr(e.date, 6, 2) AS INTEGER) = b.month
                     AND CAST(substr(e.date, 1, 4) AS INTEGER) = b.year
                    THEN e.amount ELSE 0 END), 0) AS spent
            FROM budgets b
            JOIN categories c ON c.name = b.category
            LEFT JOIN expenses e ON e.category = b.category
            WHERE c.id = ?
            GROUP BY b.id
            ORDER BY b.year DESC, b.month DESC
            """,
            (category_id,),
        ).fetchall()
        expenses = connection.execute(
            """
            SELECT id, title, amount, date, description
            FROM expenses
            WHERE category = ?
            ORDER BY date DESC, id DESC
            """,
            (category["name"],),
        ).fetchall()
    history = [row_dict(row) for row in rows]
    expense_history = [row_dict(row) for row in expenses]
    return {
        "category": row_dict(category),
        "history": history,
        "expenses": expense_history,
        "total_budgeted": sum(item["amount"] for item in history),
        "total_spent": sum(item["amount"] for item in expense_history),
    }


@app.post("/api/categories", status_code=201)
def create_category(payload: CategoryInput) -> dict[str, Any]:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Category name cannot be blank.")
    try:
        with connect_db() as connection:
            cursor = connection.execute(
                "INSERT INTO categories (name, color) VALUES (?, ?)",
                (name, payload.color),
            )
            row = connection.execute(
                "SELECT id, name, color FROM categories WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
    except sqlite3.IntegrityError as error:
        raise HTTPException(status_code=409, detail="That category already exists.") from error
    return row_dict(row)


@app.delete("/api/categories/{category_id}", status_code=204)
def delete_category(category_id: int) -> Response:
    try:
        with connect_db() as connection:
            cursor = connection.execute("DELETE FROM categories WHERE id = ?", (category_id,))
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="Category not found.")
    except sqlite3.IntegrityError as error:
        raise HTTPException(
            status_code=409, detail="Categories used by an expense or budget cannot be deleted."
        ) from error
    return Response(status_code=204)


@app.get("/api/expenses")
def list_expenses(
    search: str = Query(default="", max_length=120),
    category: str = Query(default="", max_length=60),
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[dict[str, Any]]:
    clauses: list[str] = []
    values: list[Any] = []
    if search.strip():
        clauses.append("(e.title LIKE ? OR e.description LIKE ?)")
        values.extend([f"%{search.strip()}%", f"%{search.strip()}%"])
    if category:
        clauses.append("e.category = ?")
        values.append(category)
    if date_from:
        clauses.append("e.date >= ?")
        values.append(date_from.isoformat())
    if date_to:
        clauses.append("e.date <= ?")
        values.append(date_to.isoformat())
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with connect_db() as connection:
        rows = connection.execute(
            f"""
            SELECT e.*, c.color AS category_color
            FROM expenses e JOIN categories c ON c.name = e.category
            {where}
            ORDER BY e.date DESC, e.id DESC
            """,
            values,
        ).fetchall()
    return [row_dict(row) for row in rows]


@app.get("/api/expenses/{expense_id}")
def get_expense(expense_id: int) -> dict[str, Any]:
    with connect_db() as connection:
        row = connection.execute(
            """
            SELECT e.*, c.color AS category_color
            FROM expenses e JOIN categories c ON c.name = e.category
            WHERE e.id = ?
            """,
            (expense_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Expense not found.")
    return row_dict(row)


@app.post("/api/expenses", status_code=201)
def create_expense(payload: ExpenseInput) -> dict[str, Any]:
    data = payload.model_dump()
    data["title"] = data["title"].strip()
    data["category"] = data["category"].strip()
    data["description"] = data["description"].strip()
    if not data["title"] or not data["category"]:
        raise HTTPException(status_code=422, detail="Title and category cannot be blank.")
    with connect_db() as connection:
        require_category(connection, data["category"])
        cursor = connection.execute(
            """
            INSERT INTO expenses (title, amount, category, date, description)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                data["title"],
                data["amount"],
                data["category"],
                data["date"].isoformat(),
                data["description"],
            ),
        )
        row = connection.execute(
            "SELECT * FROM expenses WHERE id = ?", (cursor.lastrowid,)
        ).fetchone()
    return row_dict(row)


@app.put("/api/expenses/{expense_id}")
def update_expense(expense_id: int, payload: ExpenseInput) -> dict[str, Any]:
    data = payload.model_dump()
    data["title"] = data["title"].strip()
    data["category"] = data["category"].strip()
    data["description"] = data["description"].strip()
    if not data["title"] or not data["category"]:
        raise HTTPException(status_code=422, detail="Title and category cannot be blank.")
    with connect_db() as connection:
        require_category(connection, data["category"])
        cursor = connection.execute(
            """
            UPDATE expenses SET title = ?, amount = ?, category = ?, date = ?, description = ?
            WHERE id = ?
            """,
            (
                data["title"],
                data["amount"],
                data["category"],
                data["date"].isoformat(),
                data["description"],
                expense_id,
            ),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Expense not found.")
        row = connection.execute(
            "SELECT * FROM expenses WHERE id = ?", (expense_id,)
        ).fetchone()
    return row_dict(row)


@app.delete("/api/expenses/{expense_id}", status_code=204)
def delete_expense(expense_id: int) -> Response:
    with connect_db() as connection:
        cursor = connection.execute("DELETE FROM expenses WHERE id = ?", (expense_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Expense not found.")
    return Response(status_code=204)


@app.get("/api/budgets")
def list_budgets(month: int | None = Query(default=None, ge=1, le=12), year: int | None = None):
    clauses: list[str] = []
    values: list[Any] = []
    if month is not None:
        clauses.append("b.month = ?")
        values.append(month)
    if year is not None:
        clauses.append("b.year = ?")
        values.append(year)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with connect_db() as connection:
        rows = connection.execute(
            f"""
            SELECT b.*, c.color,
                COALESCE(SUM(CASE
                    WHEN CAST(substr(e.date, 6, 2) AS INTEGER) = b.month
                     AND CAST(substr(e.date, 1, 4) AS INTEGER) = b.year
                    THEN e.amount ELSE 0 END), 0) AS spent
            FROM budgets b
            JOIN categories c ON c.name = b.category
            LEFT JOIN expenses e ON e.category = b.category
            {where}
            GROUP BY b.id
            ORDER BY b.year DESC, b.month DESC, b.category COLLATE NOCASE
            """,
            values,
        ).fetchall()
    return [row_dict(row) for row in rows]


@app.post("/api/budgets", status_code=201)
def create_budget(payload: BudgetInput) -> dict[str, Any]:
    data = payload.model_dump()
    data["category"] = data["category"].strip()
    if not data["category"]:
        raise HTTPException(status_code=422, detail="Category cannot be blank.")
    try:
        with connect_db() as connection:
            require_category(connection, data["category"])
            cursor = connection.execute(
                """
                INSERT INTO budgets (category, amount, month, year)
                VALUES (?, ?, ?, ?)
                """,
                (data["category"], data["amount"], data["month"], data["year"]),
            )
            row = connection.execute(
                "SELECT * FROM budgets WHERE id = ?", (cursor.lastrowid,)
            ).fetchone()
    except sqlite3.IntegrityError as error:
        raise HTTPException(
            status_code=409, detail="A budget already exists for this category and month."
        ) from error
    return row_dict(row)


@app.delete("/api/budgets/{budget_id}", status_code=204)
def delete_budget(budget_id: int) -> Response:
    with connect_db() as connection:
        cursor = connection.execute("DELETE FROM budgets WHERE id = ?", (budget_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Budget not found.")
    return Response(status_code=204)


@app.get("/api/salary")
def get_salary(
    month: int = Query(ge=1, le=12),
    year: int = Query(ge=1900, le=9999),
) -> dict[str, Any]:
    with connect_db() as connection:
        row = connection.execute(
            "SELECT amount FROM monthly_salaries WHERE month = ? AND year = ?",
            (month, year),
        ).fetchone()
    return {"amount": row["amount"] if row else None, "month": month, "year": year}


@app.put("/api/salary")
def save_salary(payload: SalaryInput) -> dict[str, Any]:
    with connect_db() as connection:
        connection.execute("BEGIN IMMEDIATE")
        has_existing_salary = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM monthly_salaries)"
        ).fetchone()[0]
        if has_existing_salary and not payload.reset_account_data:
            raise HTTPException(
                status_code=409,
                detail="Confirm the account reset before setting salary again. This clears all expenses, budgets, salaries, and savings in this account.",
            )
        if payload.reset_account_data:
            connection.execute("DELETE FROM expenses")
            connection.execute("DELETE FROM budgets")
            connection.execute("DELETE FROM monthly_salaries")
            connection.execute("DELETE FROM monthly_savings")
        connection.execute(
            """
            INSERT INTO monthly_salaries (amount, month, year)
            VALUES (?, ?, ?)
            ON CONFLICT(month, year) DO UPDATE SET amount = excluded.amount
            """,
            (payload.amount, payload.month, payload.year),
        )
        row = connection.execute(
            "SELECT amount, month, year FROM monthly_salaries WHERE month = ? AND year = ?",
            (payload.month, payload.year),
        ).fetchone()
    return row_dict(row)


@app.get("/api/savings")
def get_savings(
    month: int = Query(ge=1, le=12),
    year: int = Query(ge=1900, le=9999),
) -> dict[str, Any]:
    with connect_db() as connection:
        row = connection.execute(
            "SELECT amount FROM monthly_savings WHERE month = ? AND year = ?",
            (month, year),
        ).fetchone()
    return {"amount": row["amount"] if row else None, "month": month, "year": year}


@app.put("/api/savings")
def save_savings(payload: SavingsInput) -> dict[str, Any]:
    with connect_db() as connection:
        connection.execute(
            """
            INSERT INTO monthly_savings (amount, month, year)
            VALUES (?, ?, ?)
            ON CONFLICT(month, year) DO UPDATE SET amount = excluded.amount
            """,
            (payload.amount, payload.month, payload.year),
        )
        row = connection.execute(
            "SELECT amount, month, year FROM monthly_savings WHERE month = ? AND year = ?",
            (payload.month, payload.year),
        ).fetchone()
    return row_dict(row)


@app.get("/api/dashboard")
def dashboard(
    month: int = Query(ge=1, le=12),
    year: int = Query(ge=1900, le=9999),
) -> dict[str, Any]:
    with connect_db() as connection:
        totals = connection.execute(
            """
            SELECT COALESCE(SUM(amount), 0) AS spent, COUNT(*) AS expense_count
            FROM expenses
            WHERE substr(date, 1, 4) = ? AND substr(date, 6, 2) = ?
            """,
            (str(year), f"{month:02d}"),
        ).fetchone()
        budget = connection.execute(
            "SELECT COALESCE(SUM(amount), 0) AS total FROM budgets WHERE month = ? AND year = ?",
            (month, year),
        ).fetchone()["total"]
        budgeted_spent = connection.execute(
            """
            SELECT COALESCE(SUM(e.amount), 0) AS total
            FROM budgets b
            LEFT JOIN expenses e ON e.category = b.category
                AND CAST(substr(e.date, 6, 2) AS INTEGER) = b.month
                AND CAST(substr(e.date, 1, 4) AS INTEGER) = b.year
            WHERE b.month = ? AND b.year = ?
            """,
            (month, year),
        ).fetchone()["total"]
        salary_row = connection.execute(
            "SELECT amount FROM monthly_salaries WHERE month = ? AND year = ?",
            (month, year),
        ).fetchone()
        salary = salary_row["amount"] if salary_row else None
        savings_row = connection.execute(
            "SELECT amount FROM monthly_savings WHERE month = ? AND year = ?",
            (month, year),
        ).fetchone()
        savings = savings_row["amount"] if savings_row else None
        has_salary_records = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM monthly_salaries)"
        ).fetchone()[0]
        categories = connection.execute(
            """
            SELECT c.name, c.color, COALESCE(SUM(e.amount), 0) AS spent
            FROM categories c
            LEFT JOIN expenses e ON e.category = c.name
                AND substr(e.date, 1, 4) = ? AND substr(e.date, 6, 2) = ?
            GROUP BY c.id ORDER BY spent DESC, c.name COLLATE NOCASE
            """,
            (str(year), f"{month:02d}"),
        ).fetchall()
        recent = connection.execute(
            """
            SELECT e.*, c.color AS category_color FROM expenses e
            JOIN categories c ON c.name = e.category
            ORDER BY e.date DESC, e.id DESC LIMIT 6
            """
        ).fetchall()
    return {
        "spent": totals["spent"],
        "expense_count": totals["expense_count"],
        "budget": budget,
        "budgeted_spent": budgeted_spent,
        "unbudgeted_spent": max(totals["spent"] - budgeted_spent, 0),
        "remaining": budget - budgeted_spent if budget else None,
        "salary": salary,
        "has_salary_records": bool(has_salary_records),
        "salary_remaining": (
            salary - totals["spent"] - (savings if savings is not None else 0)
            if salary is not None
            else None
        ),
        "savings": savings,
        "categories": [row_dict(row) for row in categories if row["spent"] > 0],
        "recent_expenses": [row_dict(row) for row in recent],
    }


@app.get("/api/reports")
def reports(
    month: int = Query(ge=1, le=12),
    year: int = Query(ge=1900, le=9999),
) -> dict[str, Any]:
    with connect_db() as connection:
        category_rows = connection.execute(
            """
            SELECT c.name AS category, c.color,
                COALESCE(SUM(e.amount), 0) AS spent,
                COALESCE(b.amount, 0) AS budget
            FROM categories c
            LEFT JOIN expenses e ON e.category = c.name
                AND substr(e.date, 1, 4) = ? AND substr(e.date, 6, 2) = ?
            LEFT JOIN budgets b ON b.category = c.name
                AND b.month = ? AND b.year = ?
            GROUP BY c.id ORDER BY spent DESC, c.name COLLATE NOCASE
            """,
            (str(year), f"{month:02d}", month, year),
        ).fetchall()
        daily_rows = connection.execute(
            """
            SELECT date, SUM(amount) AS total FROM expenses
            WHERE substr(date, 1, 4) = ? AND substr(date, 6, 2) = ?
            GROUP BY date ORDER BY date
            """,
            (str(year), f"{month:02d}"),
        ).fetchall()
        salary_row = connection.execute(
            "SELECT amount FROM monthly_salaries WHERE month = ? AND year = ?",
            (month, year),
        ).fetchone()
        savings_row = connection.execute(
            "SELECT amount FROM monthly_savings WHERE month = ? AND year = ?",
            (month, year),
        ).fetchone()
    categories = [row_dict(row) for row in category_rows if row["spent"] or row["budget"]]
    total_spent = sum(item["spent"] for item in categories)
    salary = salary_row["amount"] if salary_row else None
    savings = savings_row["amount"] if savings_row else None
    return {
        "month": month,
        "year": year,
        "salary": salary,
        "salary_remaining": (
            salary - total_spent - (savings if savings is not None else 0)
            if salary is not None
            else None
        ),
        "savings": savings,
        "total_spent": total_spent,
        "total_budget": sum(item["budget"] for item in categories),
        "categories": categories,
        "daily": [row_dict(row) for row in daily_rows],
    }


@app.get("/api/trends")
def monthly_trends(
    month: int = Query(ge=1, le=12),
    year: int = Query(ge=1900, le=9999),
    periods: int = Query(default=6, ge=3, le=12),
) -> list[dict[str, Any]]:
    month_indices = [year * 12 + month - 1 - offset for offset in range(periods - 1, -1, -1)]
    months = [(index // 12, index % 12 + 1) for index in month_indices]
    start_date = date(months[0][0], months[0][1], 1).isoformat()
    end_year, end_month = months[-1]
    end_date = date(end_year, end_month, calendar.monthrange(end_year, end_month)[1]).isoformat()
    with connect_db() as connection:
        expense_rows = connection.execute(
            """
            SELECT substr(date, 1, 4) AS year, substr(date, 6, 2) AS month,
                COALESCE(SUM(amount), 0) AS spent
            FROM expenses
            WHERE date >= ? AND date <= ?
            GROUP BY substr(date, 1, 4), substr(date, 6, 2)
            """,
            (start_date, end_date),
        ).fetchall()
        salary_rows = connection.execute(
            """
            SELECT year, month, amount FROM monthly_salaries
            WHERE (year > ? OR (year = ? AND month >= ?))
              AND (year < ? OR (year = ? AND month <= ?))
            """,
            (months[0][0], months[0][0], months[0][1], end_year, end_year, end_month),
        ).fetchall()
        savings_rows = connection.execute(
            """
            SELECT year, month, amount FROM monthly_savings
            WHERE (year > ? OR (year = ? AND month >= ?))
              AND (year < ? OR (year = ? AND month <= ?))
            """,
            (months[0][0], months[0][0], months[0][1], end_year, end_year, end_month),
        ).fetchall()
    spent_by_month = {
        (int(row["year"]), int(row["month"])): row["spent"] for row in expense_rows
    }
    salary_by_month = {
        (row["year"], row["month"]): row["amount"] for row in salary_rows
    }
    savings_by_month = {
        (row["year"], row["month"]): row["amount"] for row in savings_rows
    }
    return [
        {
            "year": month_year,
            "month": month_number,
            "label": datetime(month_year, month_number, 1).strftime("%b"),
            "spent": spent_by_month.get((month_year, month_number), 0),
            "salary": salary_by_month.get((month_year, month_number)),
            "savings": savings_by_month.get((month_year, month_number)),
        }
        for month_year, month_number in months
    ]


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
