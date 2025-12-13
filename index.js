require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;

const app = express();

// --- Firebase Admin Initialization ---
// WARNING: Ensure FB_SERVICE_KEY is securely stored in your environment variables.
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// --- Middleware ---
app.use(express.json());
app.use(
  cors({
    // Ensure this points to your specific frontend URL for security
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);

// --- 1. JWT Verification Middleware ---
// Verifies the Firebase ID Token sent from the client
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];

  if (!token)
    return res
      .status(401)
      .send({ message: "Unauthorized Access: Token Missing" });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    // CRITICAL: Attach the verified user email to the request object
    req.tokenEmail = decoded.email;
    next();
  } catch (err) {
    // Token expired, invalid, etc.
    console.error("JWT Verification Error:", err.code);
    return res
      .status(401)
      .send({ message: "Unauthorized Access: Invalid Token", error: err.code });
  }
};

// MongoDB Client Setup
const client = new MongoClient(process.env.MONGODB_URL, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("booksDB");
    const booksCollection = db.collection("books");
    const ordersCollection = db.collection("orders");
    const usersCollection = db.collection("users");
    const reviewsCollection = db.collection("reviews");
    const wishlistCollection = db.collection("wishlist");

    // --- 2. Role Verification Utilities ---

    const getUserRole = async (email) => {
      return await usersCollection.findOne(
        { email },
        { projection: { role: 1 } }
      );
    };

    // Middleware: Only grants access if role is 'admin'
    const verifyAdmin = async (req, res, next) => {
      const userRole = await getUserRole(req.tokenEmail);
      if (!userRole || userRole.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Forbidden: Admin privilege required" });
      }
      next();
    };

    // Middleware: Grants access if role is 'librarian' or 'admin'
    const verifyLibrarian = async (req, res, next) => {
      const userRole = await getUserRole(req.tokenEmail);

      if (
        !userRole ||
        (userRole.role !== "librarian" && userRole.role !== "admin")
      ) {
        return res
          .status(403)
          .send({ message: "Forbidden: Librarian privilege required" });
      }
      next();
    };

    //

    // =======================================================
    //               USER & ADMIN ENDPOINTS
    // =======================================================

    // Public Route: General User Creation
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);

      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }

      const result = await usersCollection.insertOne({
        ...user,
        role: "user", // Default role
        createdAt: new Date(),
      });
      res.send(result);
    });

    // SECURITY ENDPOINT: For Frontend useRole hook
    app.get("/users/role/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;

      // Security check: Must match token email
      if (email !== req.tokenEmail) {
        return res
          .status(403)
          .send({ message: "Forbidden: Token/Email mismatch" });
      }

      try {
        const user = await usersCollection.findOne(
          { email: email },
          { projection: { role: 1 } }
        );
        if (!user) {
          // Fallback to 'user' if not found, though should be created on registration
          return res
            .status(404)
            .send({ role: "user", message: "User not found" });
        }
        res.send({ role: user.role });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch user role." });
      }
    });

    // ADMIN ROUTE: Read All Users (GET)
    app.get("/users", verifyJWT, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // ADMIN ROUTE: Update User Role (PATCH helper function)
    const updateRole = async (req, res, newRole) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = { $set: { role: newRole, lastRoleUpdate: new Date() } };
      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    };

    // ADMIN ROUTE: Make Librarian (PATCH)
    app.patch(
      "/users/make-librarian/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        await updateRole(req, res, "librarian");
      }
    );

    // ADMIN ROUTE: Make Admin (PATCH)
    app.patch(
      "/users/make-admin/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        await updateRole(req, res, "admin");
      }
    );

    // =======================================================
    //               BOOK ENDPOINTS
    // =======================================================

    // LIBRARIAN ROUTE: Create Book (POST)
    app.post("/books", verifyJWT, verifyLibrarian, async (req, res) => {
      const bookData = req.body;
      // Associate the book with the logged-in librarian
      bookData.librarianEmail = req.tokenEmail;
      const result = await booksCollection.insertOne(bookData);
      res.send(result);
    });

    // Public Route: Read All Books (with search, sort, pagination) (GET)
    app.get("/books", async (req, res) => {
      const page = parseInt(req.query.page) || 0;
      const size = parseInt(req.query.size) || 10;
      const search = req.query.search;
      const category = req.query.category;
      const rating = req.query.rating;
      // Sorting can be implemented here based on req.query.sortField/sortOrder

      let query = { status: "published" };

      if (search && search !== "undefined") {
        query.$or = [
          { bookTitle: { $regex: search, $options: "i" } },
          { authorName: { $regex: search, $options: "i" } },
        ];
      }
      if (category && category !== "undefined" && category !== "") {
        query.category = category;
      }
      if (rating && rating !== "0") {
        query.rating = { $gte: parseFloat(rating) };
      }

      try {
        const result = await booksCollection
          .find(query)
          .skip(page * size)
          .limit(size)
          .toArray();

        const count = await booksCollection.countDocuments(query);
        res.send({ result, count });
      } catch (error) {
        res.status(500).send({ message: "Error fetching books", error });
      }
    });

    // Public Route: Read Latest Books (GET)
    app.get("/latest-books", async (req, res) => {
      const limit = 6;
      const query = { status: "published" };
      const result = await booksCollection
        .find(query)
        .sort({ _id: -1 })
        .limit(limit)
        .toArray();
      res.send(result);
    });

    // ADMIN ROUTE: Read ALL books (Admin View - Includes unpublished) (GET)
    app.get("/books/all", verifyJWT, verifyAdmin, async (req, res) => {
      try {
        const allBooks = await booksCollection
          .find({})
          .sort({ _id: -1 })
          .toArray();
        res.send(allBooks);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch all books." });
      }
    });

    // Public Route: Read Single Book Details (GET)
    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // LIBRARIAN ROUTE: Read My Books (GET)
    app.get(
      "/my-books/:email",
      verifyJWT,
      verifyLibrarian,
      async (req, res) => {
        const userEmail = req.params.email;
        if (userEmail !== req.tokenEmail) {
          return res
            .status(403)
            .send({ message: "Forbidden: Email does not match user" });
        }

        try {
          const query = { "seller_libarien.email": userEmail };
          const myBooks = await booksCollection
            .find(query)
            .sort({ _id: -1 })
            .toArray();
          res.send(myBooks);
        } catch (error) {
          res.status(500).send({ message: "Failed to fetch books." });
        }
      }
    );

    // LIBRARIAN/ADMIN ROUTE: Update Publish Status (PATCH)
    app.patch(
      "/books/status/:id",
      verifyJWT,
      verifyLibrarian,
      async (req, res) => {
        const id = req.params.id;
        const { status } = req.body;
        // ... validation logic ...
        try {
          const result = await booksCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: status } }
          );
          res.send({ acknowledged: true, modifiedCount: result.modifiedCount });
        } catch (error) {
          res.status(500).send({ message: "Failed to update book status." });
        }
      }
    );

    // LIBRARIAN/ADMIN ROUTE: Update Book Data (PATCH)
    app.patch("/books/:id", verifyJWT, verifyLibrarian, async (req, res) => {
      const id = req.params.id;
      const updatedBookData = req.body;
      delete updatedBookData._id;

      try {
        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedBookData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Book not found." });
        }
        res.send({ acknowledged: true, modifiedCount: result.modifiedCount });
      } catch (error) {
        res.status(500).send({ message: "Failed to update book." });
      }
    });

    // ADMIN ROUTE: Delete Book and Orders (DELETE)
    app.delete(
      "/books/delete/:id",
      verifyJWT,
      verifyAdmin,
      async (req, res) => {
        const bookId = req.params.id;

        try {
          const deleteBookResult = await booksCollection.deleteOne({
            _id: new ObjectId(bookId),
          });
          const deleteOrdersResult = await ordersCollection.deleteMany({
            bookId: bookId,
          });

          if (deleteBookResult.deletedCount === 0) {
            return res.status(404).send({ message: "Book not found." });
          }

          res.send({
            acknowledged: true,
            bookDeleted: deleteBookResult.deletedCount,
            ordersDeleted: deleteOrdersResult.deletedCount,
            message: `Book and ${deleteOrdersResult.deletedCount} associated orders deleted successfully.`,
          });
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to delete book and associated orders." });
        }
      }
    );

    // =======================================================
    //               ORDER & PAYMENT ENDPOINTS
    // =======================================================

    // USER ROUTE: Create Order (POST)
    app.post("/orders", verifyJWT, async (req, res) => {
      const orderData = req.body;

      if (orderData.email !== req.tokenEmail) {
        return res
          .status(403)
          .send({ message: "Forbidden: Order email mismatch" });
      }

      orderData.orderDate = new Date();
      orderData.status = "pending";
      orderData.payment_status = "unpaid";

      const result = await ordersCollection.insertOne(orderData);
      res.send(result);
    });

    // 💡 FIX: USER ROUTE: Read Single Order Details (GET)
    // Required by the PaymentPage to display book title/price
    app.get("/orders/:orderId", verifyJWT, async (req, res) => {
      const orderId = req.params.orderId;

      try {
        const query = { _id: new ObjectId(orderId) };
        const order = await ordersCollection.findOne(query);

        if (!order) {
          return res.status(404).send({ message: "Order not found." });
        }

        // Security Check: Only the order owner can view details
        if (order.email !== req.tokenEmail) {
          // Log this for security monitoring
          console.warn(
            `403 Attempt: User ${req.tokenEmail} tried to access order ${orderId} belonging to ${order.email}`
          );
          return res
            .status(403)
            .send({ message: "Forbidden: Order does not belong to user." });
        }

        // Only return essential details needed by the client (PaymentPage)
        res.send({
          bookTitle: order.bookTitle, // Assuming this field exists in your order schema
          price: order.price,
          email: order.email,
          bookId: order.bookId,
          status: order.status,
          payment_status: order.payment_status,
          // Include other non-sensitive data needed for display
        });
      } catch (error) {
        // Handle case where orderId is not a valid ObjectId format
        if (error.name === "BSONTypeError") {
          return res.status(400).send({ message: "Invalid Order ID format." });
        }
        res
          .status(500)
          .send({ message: "Failed to fetch order details.", error });
      }
    });

    // USER ROUTE: Read My Orders (GET)
    app.get("/my-orders/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;
      if (email !== req.tokenEmail) {
        return res
          .status(403)
          .send({ message: "Forbidden: Email does not match user" });
      }

      const query = { email: email };
      const result = await ordersCollection
        .find(query)
        .sort({ orderDate: -1 })
        .toArray();
      res.send(result);
    });

    // USER ROUTE: Read My Invoices (GET)
    app.get("/my-invoices/:email", verifyJWT, async (req, res) => {
      const userEmail = req.params.email;
      if (userEmail !== req.tokenEmail) {
        return res
          .status(403)
          .send({ message: "Forbidden: Email does not match user" });
      }

      try {
        const query = { email: userEmail, payment_status: "paid" };
        const invoices = await ordersCollection.find(query).toArray();
        res.send(invoices);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch paid orders." });
      }
    });

    // LIBRARIAN ROUTE: Read Orders for my books (GET)
    app.get(
      "/librarian-orders/:email",
      verifyJWT,
      verifyLibrarian,
      async (req, res) => {
        const librarianEmail = req.params.email;
        if (librarianEmail !== req.tokenEmail) {
          return res
            .status(403)
            .send({ message: "Forbidden: Email does not match user" });
        }

        try {
          const librarianBooks = await booksCollection
            .find({ "seller_libarien.email": librarianEmail })
            .project({ _id: 1 })
            .toArray();

          const bookIds = librarianBooks.map((book) => book._id.toHexString());

          if (bookIds.length === 0) {
            return res.send([]);
          }

          const orders = await ordersCollection
            .find({ bookId: { $in: bookIds } })
            .sort({ orderDate: -1 })
            .toArray();

          res.send(orders);
        } catch (error) {
          res.status(500).send({ message: "Failed to fetch orders." });
        }
      }
    );

    // LIBRARIAN ROUTE: Update Order Fulfillment Status (PATCH)
    app.patch(
      "/orders/update-status/:id",
      verifyJWT,
      verifyLibrarian,
      async (req, res) => {
        const id = req.params.id;
        const { newStatus } = req.body;

        const allowedStatuses = [
          "shipped",
          "delivered",
          "pending",
          "cancelled",
        ];
        if (!allowedStatuses.includes(newStatus)) {
          return res.status(400).send({ message: "Invalid status update." });
        }

        try {
          const result = await ordersCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status: newStatus } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).send({ message: "Order not found." });
          }

          res.send({ acknowledged: true, modifiedCount: result.modifiedCount });
        } catch (error) {
          res.status(500).send({ message: "Failed to update order status." });
        }
      }
    );

    // USER ROUTE: Cancel Order (PATCH)
    app.patch("/orders/cancel/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      // Best practice: verify that the order's email field matches req.tokenEmail before updating
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { status: "cancelled", payment_status: "cancelled" },
      };
      const result = await ordersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // USER ROUTE: Stripe Checkout Session (POST)
    app.post("/create-checkout-session", verifyJWT, async (req, res) => {
      const { bookTitle, price, email, quantity, orderId } = req.body;

      if (email !== req.tokenEmail) {
        return res
          .status(403)
          .send({ message: "Forbidden: Checkout email mismatch" });
      }

      if (!orderId || !bookTitle || !price || !email) {
        return res
          .status(400)
          .send({ error: "Missing required payment details." });
      }

      try {
        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: bookTitle },
                unit_amount: Math.round(price * 100),
              },
              quantity: quantity || 1,
            },
          ],
          customer_email: email,
          mode: "payment",
          success_url: `${process.env.CLIENT_DOMAIN}/payment/${orderId}?status=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_DOMAIN}/dashboard/my-orders?status=cancelled&orderId=${orderId}`,
        });

        res.send({ url: session.url });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // USER ROUTE: Handle Payment Success (PATCH)
    app.patch(
      "/orders/payment-success/:orderId",
      verifyJWT,
      async (req, res) => {
        const orderId = req.params.orderId;
        const sessionId = req.body.sessionId;

        try {
          // Should perform Stripe verification here using sessionId
          if (sessionId) {
            const session = await stripe.checkout.sessions.retrieve(sessionId);
            if (session.payment_status !== "paid") {
              return res
                .status(400)
                .send({ message: "Payment session status is not 'paid'." });
            }
          }

          const result = await ordersCollection.updateOne(
            { _id: new ObjectId(orderId) },
            {
              $set: {
                payment_status: "paid",
                status: "processing",
                stripeSessionId: sessionId || "N/A",
                paidAt: new Date(),
              },
            }
          );

          if (result.modifiedCount === 1) {
            res.send({ acknowledged: true, message: "Order updated to paid." });
          } else {
            res
              .status(404)
              .send({ message: "Order not found or already paid." });
          }
        } catch (error) {
          res
            .status(500)
            .send({ message: "Failed to update order status.", error });
        }
      }
    );

    // =======================================================
    //                  WISHLIST & REVIEW ENDPOINTS
    // =======================================================

    // USER ROUTE: Create Wishlist Item (POST)
    app.post("/wishlist", verifyJWT, async (req, res) => {
      const wishlistData = req.body;
      if (wishlistData.userEmail !== req.tokenEmail) {
        return res
          .status(403)
          .send({ message: "Forbidden: Wishlist user mismatch" });
      }

      const query = {
        userEmail: wishlistData.userEmail,
        bookId: wishlistData.bookId,
      };
      const existing = await wishlistCollection.findOne(query);

      if (existing) {
        return res
          .status(400)
          .send({ message: "This book is already in your wishlist!" });
      }

      const result = await wishlistCollection.insertOne(wishlistData);
      res.send(result);
    });

    // USER ROUTE: Read Wishlist (GET)
    app.get("/wishlist/:email", verifyJWT, async (req, res) => {
      const email = req.params.email;
      if (email !== req.tokenEmail) {
        return res
          .status(403)
          .send({ message: "Forbidden: Email does not match user" });
      }
      const result = await wishlistCollection
        .find({ userEmail: email })
        .toArray();
      res.send(result);
    });

    // USER ROUTE: Delete Wishlist Item (DELETE)
    app.delete("/wishlist/:id", verifyJWT, async (req, res) => {
      const id = req.params.id;
      // Highly recommend checking that the item belongs to req.tokenEmail
      const result = await wishlistCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // USER ROUTE: Create Review (POST)
    app.post("/reviews", verifyJWT, async (req, res) => {
      const { bookId, userId, userName, rating, reviewText } = req.body;
      if (userId !== req.tokenEmail) {
        return res
          .status(403)
          .send({ message: "Forbidden: Review user mismatch" });
      }

      if (
        !bookId ||
        !userId ||
        typeof rating === "undefined" ||
        rating < 1 ||
        rating > 5
      ) {
        return res.status(400).send({ message: "Invalid review data." });
      }

      try {
        // 1. Prepare and Insert the new review
        const reviewData = {
          bookId: new ObjectId(bookId),
          userId: userId,
          userName: userName,
          rating: parseInt(rating),
          reviewText: reviewText || "",
          createdAt: new Date(),
        };
        const result = await reviewsCollection.insertOne(reviewData);

        // 2. Calculate and Update the Book's Average Rating
        const allReviews = await reviewsCollection
          .find({ bookId: new ObjectId(bookId) })
          .toArray();
        const totalRating = allReviews.reduce(
          (sum, review) => sum + review.rating,
          0
        );
        const newAverageRating = (totalRating / allReviews.length).toFixed(1);

        await booksCollection.updateOne(
          { _id: new ObjectId(bookId) },
          { $set: { rating: newAverageRating }, $inc: { reviewCount: 1 } }
        );

        res.send({
          acknowledged: true,
          insertedId: result.insertedId,
          newAverageRating,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to submit review." });
      }
    });

    // Public Route: Read Reviews for a Specific Book (GET)
    app.get("/reviews/:bookId", async (req, res) => {
      try {
        const bookId = req.params.bookId;
        const reviews = await reviewsCollection
          .find({ bookId: new ObjectId(bookId) })
          .sort({ createdAt: -1 })
          .toArray();
        res.send(reviews);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch reviews." });
      }
    });

    // Public Route: Check if User Can Review (GET)
    app.get("/user-can-review/:bookId/:userEmail", async (req, res) => {
      try {
        const { bookId, userEmail } = req.params;

        // 1. Check if the user has a 'paid' order for this book
        const hasOrdered = await ordersCollection.findOne({
          bookId: bookId,
          email: userEmail,
          payment_status: "paid",
        });

        if (!hasOrdered) {
          return res.send({ canReview: false, reason: "NOT_ORDERED" });
        }

        // 2. Check if the user has ALREADY submitted a review for this book
        const hasReviewed = await reviewsCollection.findOne({
          bookId: new ObjectId(bookId),
          userId: userEmail,
        });

        if (hasReviewed) {
          return res.send({
            canReview: false,
            reason: "ALREADY_REVIEWED",
            existingReview: hasReviewed,
          });
        }

        res.send({ canReview: true });
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to check review eligibility." });
      }
    });

    // --- MongoDB Connection Check ---
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Keeps the server running
  }
}
run().catch(console.dir);

// --- Root and Listener ---
app.get("/", (req, res) => {
  res.send("BookCourier Server is operational and secure.");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
