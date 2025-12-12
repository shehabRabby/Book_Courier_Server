require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
// WARNING: Using the Secret Key for verification is not secure.
// The STRIPE_WEBHOOK_SECRET is the correct way to verify events.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const admin = require("firebase-admin");
const port = process.env.PORT || 3000;

// Initialize Firebase Admin (JWT Verification)
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);
const serviceAccount = JSON.parse(decoded);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();

// middleware
app.use(express.json());
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
);

// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
};

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
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

    // --- BOOK ENDPOINTS (Write Operations) ---
    app.post("/books", async (req, res) => {
      const bookData = req.body;
      const result = await booksCollection.insertOne(bookData);
      res.send(result);
    });

    // --- PAYMENT (Stripe) ENDPOINTS ---
    app.post("/create-checkout-session", async (req, res) => {
      const { bookTitle, price, email, quantity, orderId } = req.body;

      if (!orderId || !bookTitle || !price || !email) {
        return res.status(400).send({
          error:
            "Missing required payment details (Order ID, Title, Price, Email).",
        });
      }

      try {
        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: {
                  name: bookTitle,
                },
                unit_amount: Math.round(price * 100), // Convert to cents, ensure integer
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
        console.error("Stripe Checkout Error:", error);
        res.status(500).send({ error: error.message });
      }
    });

    // --- ORDER ENDPOINTS (Write Operations) ---
    app.post("/orders", async (req, res) => {
      const orderData = req.body;
      orderData.orderDate = new Date();
      orderData.status = "pending";
      orderData.payment_status = "unpaid";

      const result = await ordersCollection.insertOne(orderData);
      res.send(result);
    });

    app.patch("/orders/payment-success/:orderId", async (req, res) => {
      const orderId = req.params.orderId;
      const sessionId = req.body.sessionId; 

      try {
        // ... (Stripe verification logic) ...
        if (sessionId) {
          const session = await stripe.checkout.sessions.retrieve(sessionId);
          if (session.payment_status !== "paid") {
            console.log( `Payment success update failed: Session ${sessionId} is not paid.`);
            return res.status(400).send({ message: "Payment session status is not 'paid'." });
          }
        } else {
          console.log("Warning: No session ID provided. Proceeding with client's payment success claim.");
        }

        // Update DB
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
          res.status(404).send({ message: "Order not found or already paid." });
        }
      } catch (error) {
        console.error("Payment Success Update Error:", error);
        res.status(500).send({ message: "Failed to update order status.", error });
      }
    });

    app.patch("/orders/cancel/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = { $set: { status: "cancelled", payment_status: "cancelled" } };
      const result = await ordersCollection.updateOne(query, updateDoc);
      res.send(result);
    }); 

    app.patch("/orders/pay/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = { $set: { payment_status: "paid", status: "processing" } };
      const result = await ordersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // --- USER ENDPOINTS ---
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);

      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }

      const result = await usersCollection.insertOne({
        ...user,
        role: "user",
        createdAt: new Date(),
      });
      res.send(result);
    });
    
    // --- ⭐ ADMIN ENDPOINT: Get All Users (GET) ---
    app.get("/users", async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // --- ADMIN ENDPOINT: Update User Role (PATCH) ---
    const updateRole = async (req, res, newRole) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = { $set: { role: newRole, lastRoleUpdate: new Date() } };
      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    };

    app.patch("/users/make-librarian/:id", async (req, res) => {
      await updateRole(req, res, "librarian");
    });

    app.patch("/users/make-admin/:id", async (req, res) => {
      await updateRole(req, res, "admin");
    });
    
    // --- BOOK ENDPOINTS (Read Operations) ---
    // 1. Get all published books (least specific, but safe here)
    app.get("/books", async (req, res) => {
      const query = { status: "published" };
      const result = await booksCollection.find(query).toArray();
      res.send(result);
    });

    // 2. Get latest published books (specific prefix)
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

    // 3. ⭐ ADMIN ROUTE: Get ALL books (Admin View - MUST BE BEFORE /books/:id)
    app.get("/books/all", async (req, res) => {
      try {
        const allBooks = await booksCollection
          .find({})
          .sort({ _id: -1 })
          .toArray();

        res.send(allBooks);
      } catch (error) {
        console.error("Error fetching all books for admin:", error);
        res.status(500).send({ message: "Failed to fetch all books." });
      }
    });
    
    // 4. Get a single book (Most general parameter route - MUST BE LAST)
    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });
    
    // --- LIBRARIAN/USER Read & Update ENDPOINTS ---
    app.get("/my-invoices/:email", async (req, res) => {
      const userEmail = req.params.email;
      if (!userEmail) {
        return res.status(400).send({ message: "Email required" });
      }

      try {
        const query = { email: userEmail, payment_status: "paid" };
        const invoices = await ordersCollection.find(query).toArray();
        res.send(invoices);
      } catch (error) {
        console.error("Error fetching invoices:", error);
        res.status(500).send({ message: "Failed to fetch paid orders." });
      }
    });

    app.get("/my-books/:email", async (req, res) => {
      const userEmail = req.params.email;

      if (!userEmail) {
        return res.status(400).send({ message: "Email parameter is required." });
      }

      try {
        const query = { "seller_libarien.email": userEmail };
        const myBooks = await booksCollection
          .find(query)
          .sort({ _id: -1 })
          .toArray();

        res.send(myBooks);
      } catch (error) {
        console.error("Error fetching librarian's books:", error);
        res.status(500).send({ message: "Failed to fetch books." });
      }
    });

    app.patch("/books/status/:id", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body; 

      if (!status || (status !== "published" && status !== "unpublished")) {
        return res.status(400).send({ message: "Invalid status provided." });
      }

      try {
        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: status } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Book not found." });
        }
        res.send({ acknowledged: true, modifiedCount: result.modifiedCount });
      } catch (error) {
        console.error("Error updating book status:", error);
        res.status(500).send({ message: "Failed to update book status." });
      }
    });

    app.patch("/books/:id", async (req, res) => {
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
        console.error("Error updating book:", error);
        res.status(500).send({ message: "Failed to update book." });
      }
    });
    
    // --- ORDER ENDPOINTS (Read Operations) ---
    app.get("/my-orders/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await ordersCollection
        .find(query)
        .sort({ orderDate: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/orders/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await ordersCollection.findOne({ _id: new ObjectId(id) });
        if (!result)
          return res.status(404).send({ message: "Order not found" });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching order", error });
      }
    });


    // --- ADMIN ENDPOINT: DELETE BOOK AND RELATED ORDERS (DELETE) ---
    app.delete("/books/delete/:id", async (req, res) => {
      const bookId = req.params.id;

      try {
            // ... (The implementation logic is fine here as it's a specific route)
            const deleteBookResult = await booksCollection.deleteOne({ _id: new ObjectId(bookId) });
            const deleteOrdersResult = await ordersCollection.deleteMany({ bookId: bookId });

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
            console.error("Error deleting book and orders:", error);
            res.status(500).send({ message: "Failed to delete book and associated orders." });
          }
    });


// --- ⭐ NEW LIBRARIAN ENDPOINT: GET ORDERS FOR HIS/HER BOOKS (GET) ---
    app.get("/librarian-orders/:email", async (req, res) => {
        const librarianEmail = req.params.email;

        try {
            // 1. Find all Book IDs added by this librarian
            const librarianBooks = await booksCollection
                .find({ "seller_libarien.email": librarianEmail })
                .project({ _id: 1 }) // Only select the _id field
                .toArray();

            // Extract the string IDs
            const bookIds = librarianBooks.map(book => book._id.toHexString());

            if (bookIds.length === 0) {
                return res.send([]); // No books found, so no orders
            }

            // 2. Find all orders associated with these book IDs
            // We assume the orders collection stores the book's ObjectId as a string field named 'bookId'
            const orders = await ordersCollection
                .find({ bookId: { $in: bookIds } }) 
                .sort({ orderDate: -1 }) // Latest orders first
                .toArray();

            res.send(orders);
        } catch (error) {
            console.error("Error fetching librarian's orders:", error);
            res.status(500).send({ message: "Failed to fetch orders." });
        }
    });

    // --- ⭐ NEW LIBRARIAN ENDPOINT: UPDATE ORDER FULFILLMENT STATUS (PATCH) ---
    app.patch("/orders/update-status/:id", async (req, res) => {
        const id = req.params.id;
        const { newStatus } = req.body; // Expecting 'shipped' or 'delivered'

        const allowedStatuses = ["shipped", "delivered", "pending", "cancelled"];
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
            console.error("Error updating order status:", error);
            res.status(500).send({ message: "Failed to update order status." });
        }
    });


    //reviews related

    app.post('/reviews', async (req, res) => {
    const { bookId, userId, userName, rating, reviewText } = req.body;

    // Basic validation
    if (!bookId || !userId || typeof rating === 'undefined' || rating < 1 || rating > 5) {
        return res.status(400).send({ message: "Invalid review data." });
    }

    try {
        // 1. Prepare the review document
        const reviewData = {
            bookId: new ObjectId(bookId),
            userId: userId, // User email or ID
            userName: userName,
            rating: parseInt(rating),
            reviewText: reviewText || '',
            createdAt: new Date()
        };

        // 2. Insert the new review
        const result = await reviewsCollection.insertOne(reviewData);

        // 3. Calculate and Update the Book's Average Rating
        
        // Find all reviews for this book
        const allReviews = await reviewsCollection.find({ bookId: new ObjectId(bookId) }).toArray();
        
        // Calculate new average
        const totalRating = allReviews.reduce((sum, review) => sum + review.rating, 0);
        const newAverageRating = (totalRating / allReviews.length).toFixed(1);

        // Update the book's rating and review count
        await booksCollection.updateOne(
            { _id: new ObjectId(bookId) },
            { $set: { rating: newAverageRating }, $inc: { reviewCount: 1 } } // Assuming you track reviewCount
        );

        res.send({ acknowledged: true, insertedId: result.insertedId, newAverageRating });

    } catch (error) {
        console.error("Error submitting review:", error);
        res.status(500).send({ message: "Failed to submit review." });
    }
});



// --- Get Reviews for a Specific Book (GET) ---
app.get("/reviews/:bookId", async (req, res) => {
    try {
        const bookId = req.params.bookId;
        const reviews = await reviewsCollection
            .find({ bookId: new ObjectId(bookId) })
            .sort({ createdAt: -1 }) // Show newest reviews first
            .toArray();
        res.send(reviews);
    } catch (error) {
        console.error("Error fetching reviews:", error);
        res.status(500).send({ message: "Failed to fetch reviews." });
    }
});

// --- Check if User Can Review (GET) ---
app.get("/user-can-review/:bookId/:userEmail", async (req, res) => {
    try {
        const { bookId, userEmail } = req.params;

        // 1. Check if the user has a 'paid' order for this book
        const hasOrdered = await ordersCollection.findOne({
            bookId: bookId,
            email: userEmail,
            payment_status: 'paid'
        });

        if (!hasOrdered) {
            return res.send({ canReview: false, reason: 'NOT_ORDERED' });
        }

        // 2. Check if the user has ALREADY submitted a review for this book
        const hasReviewed = await reviewsCollection.findOne({
            bookId: new ObjectId(bookId),
            userId: userEmail // Assuming userId is the user's email
        });

        if (hasReviewed) {
            return res.send({ canReview: false, reason: 'ALREADY_REVIEWED', existingReview: hasReviewed });
        }

        res.send({ canReview: true });
    } catch (error) {
        console.error("Error checking review eligibility:", error);
        res.status(500).send({ message: "Failed to check review eligibility." });
    }
});








    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from Server..I am here");
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});