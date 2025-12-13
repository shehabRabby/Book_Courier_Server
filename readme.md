# ⚙️ BookCourier Server-Side (REST API)

## Project Overview

This repository houses the robust and secure RESTful API that powers the BookCourier application. Built with Node.js and Express.js, it manages all core business logic, database interactions, user authentication, authorization (role-based access control), and secure payment processing.

## 🔒 Security and Architecture

### Key Security Implementations

* **Environment Variables:** All sensitive credentials (MongoDB URI, JWT Secret, Firebase/Stripe keys) are secured using the `dotenv` package.
    * *Requirement Fulfilled: Secure your MongoDB credentials using the environment variable.*
* **JSON Web Tokens (JWT):** Used for creating secure, stateless access tokens. The server verifies tokens for all protected routes, ensuring that only authenticated users with the correct permissions can access specific endpoints.
    * *Challenge Fulfilled: For protected routes use firebase token verification (by verifying the decoded Firebase token on the server).*
* **CORS Configuration:** Properly configured to allow requests only from the deployed client-side domain, ensuring security and smooth production deployment.
* **Role-Based Access Control (RBAC):** Middleware is implemented to check the user's role (**User**, **Librarian**, **Admin**) before allowing access to role-specific endpoints (e.g., Admin dashboard routes).

### Data Modeling

The database schema is structured to support the multi-role environment:

* **Users:** Stores basic user information, email, image, and assigned role.
* **Books:** Stores book details, including status, author, and the ID of the contributing librarian.
* **Orders:** Stores user orders, linking to the book, tracking status (**Pending**, **Shipped**, **Delivered**, **Cancelled**), and payment status (**Paid/Unpaid**).
* **Wishlist:** Stores user-book relationships for the wishlist feature.
* **Reviews/Ratings:** Stores user feedback linked to a specific book.

## 🛠️ Technology Stack

| Component | Technology/Tool | Purpose |
| :--- | :--- | :--- |
| **Runtime Environment** | Node.js | Server-side execution environment. |
| **Framework** | Express.js | Fast, minimalist web application framework. |
| **Database** | MongoDB (via Mongoose) | Flexible, NoSQL database for data storage. |
| **Authentication** | Firebase Admin SDK / JWT | Token verification and secure session management. |
| **Payment Processing** | Stripe | Handling secure, tokenized payments for book orders. |
| **Security** | `dotenv`, `cors`, `helmet` | Protecting API keys, managing cross-origin requests, and setting secure HTTP headers. |

## 🚀 Getting Started

### Prerequisites

* Node.js (LTS recommended)
* npm or yarn
* A running MongoDB instance (Local or Atlas)
* Stripe Account for payment gateway configuration

### Installation and Setup

1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/shehabRabby/Book_Courier_Server.git](https://github.com/shehabRabby/Book_Courier_Server.git)
    cd Book_Courier_Server
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```

3.  **Configure Environment Variables:**
    Create a `.env` file in the root directory. This is crucial for security and fulfilling the requirement to secure MongoDB credentials.

    ```env
    # .env
    PORT=5000
    # MongoDB Atlas Connection String
    DB_USER=your_mongo_user
    DB_PASS=your_mongo_password
    DB_NAME=BookCourier
    MONGODB_URI=mongodb+srv://${DB_USER}:${DB_PASS}@cluster0.xxxxxxx.mongodb.net/${DB_NAME}?retryWrites=true&w=majority

    # JSON Web Token Secret (Use a strong, long, random key)
    ACCESS_TOKEN_SECRET=YOUR_VERY_SECURE_JWT_SECRET

    # Stripe Secret Key for Payment Processing
    STRIPE_SECRET_KEY=sk_test_xxxxxx

    # Client URL (For CORS and Production settings)
    CLIENT_URL=[https://book-parcel.web.app](https://book-parcel.web.app)
    ```

4.  **Run the server:**
    ```bash
    npm start
    # or
    yarn start
    ```

    The server will start running on the specified port (e.g., `http://localhost:5000`).

## 📁 API Endpoints

The API follows RESTful conventions and is organized by feature and user role.

| Endpoint Category | Method | Route | Description | Role Access |
| :--- | :--- | :--- | :--- | :--- |
| **Authentication** | `POST` | `/api/v1/auth/access-token` | Generate JWT after Firebase token verification. | Public |
| **Books (Public)** | `GET` | `/api/v1/books` | Get all published books (with search/sort). | Public |
| | `GET` | `/api/v1/books/:id` | Get single book details. | Public |
| **Orders (User)** | `POST` | `/api/v1/orders` | Place a new book order. | User |
| | `GET` | `/api/v1/orders/user` | View user's own orders. | User |
| | `PATCH` | `/api/v1/orders/:id/cancel` | Cancel a pending order. | User |
| **Librarian Books** | `POST` | `/api/v1/librarian/books` | Add a new book. | Librarian |
| | `GET` | `/api/v1/librarian/books` | View books added by the librarian. | Librarian |
| | `PATCH` | `/api/v1/librarian/books/:id` | Edit/Unpublish a book. | Librarian |
| **Librarian Orders** | `GET` | `/api/v1/librarian/orders` | View orders for their added books. | Librarian |
| | `PATCH` | `/api/v1/librarian/orders/:id/status` | Update order status (Shipped/Delivered). | Librarian |
| **Admin Users** | `GET` | `/api/v1/admin/users` | View all users. | Admin |
| | `PATCH` | `/api/v1/admin/users/:id/role` | Update user role (Librarian/Admin). | Admin |
| **Admin Books** | `GET` | `/api/v1/admin/manage-books` | View all books (published/unpublished). | Admin |
| | `DELETE` | `/api/v1/admin/books/:id` | Delete a book (and associated orders). | Admin |
| **Payment** | `POST` | `/api/v1/payment/create-intent` | Creates a Stripe payment intent. | User |

## 📦 Deployment Guidelines

The server is optimized for reliable deployment on platforms like Vercel or Render.

1.  **Deployment Platform Setup:** Choose a platform (e.g., Render) and connect it to this GitHub repository.
2.  **Environment Variables:** Ensure all secrets defined in your local `.env` file are replicated as environment variables on the deployment platform.
3.  **CORS:** In production, ensure the `CLIENT_URL` environment variable is correctly set to your live client-side link (`https://book-parcel.web.app/`) to avoid CORS errors.
4.  **Process Management:** The server uses the standard `start` script defined in `package.json`, ensuring the application runs smoothly in the production environment.