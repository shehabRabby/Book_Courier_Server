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
    const ordersCollection = db.collection("orders"); //save a book data in db

    app.post("/books", async (req, res) => {
      const bookData = req.body;
      const result = await booksCollection.insertOne(bookData);
      res.send(result);
    }); // ⭐ UPDATED ENDPOINT: Create Checkout Session

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
          // Passing orderId and sessionId in the success_url is critical for client-side update
          success_url: `${process.env.CLIENT_DOMAIN}/payment/${orderId}?status=success&session_id={CHECKOUT_SESSION_ID}`,
          // Redirect on cancel
          cancel_url: `${process.env.CLIENT_DOMAIN}/dashboard/my-orders?status=cancelled&orderId=${orderId}`,
        });

        res.send({ url: session.url });
      } catch (error) {
        console.error("Stripe Checkout Error:", error);
        res.status(500).send({ error: error.message });
      }
    }); // ---  NEW ENDPOINT 1: PLACE ORDER (POST) ---

    app.post("/orders", async (req, res) => {
      const orderData = req.body;
      orderData.orderDate = new Date();
      orderData.status = "pending";
      orderData.payment_status = "unpaid";

      const result = await ordersCollection.insertOne(orderData);
      res.send(result);
    }); // --- ⭐ NEW ENDPOINT 2: GET MY ORDERS BY EMAIL (GET) ---

    app.get("/my-orders/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await ordersCollection
        .find(query)
        .sort({ orderDate: -1 })
        .toArray();
      res.send(result);
    });

    // --- ⭐ GET SINGLE ORDER BY ID (HELPER FOR PAYMENTPAGE) ---
    app.get("/orders/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const result = await ordersCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!result)
          return res.status(404).send({ message: "Order not found" });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching order", error });
      }
    });

    // ⭐ CRITICAL NEW ENDPOINT: Update order status post-client redirect
    app.patch("/orders/payment-success/:orderId", async (req, res) => {
      const orderId = req.params.orderId;
      const sessionId = req.body.sessionId; // Expecting session ID from frontend

      try {
        // OPTIONAL: Verify payment status using Stripe API (more secure than just trusting client)
        // This requires the Stripe Secret Key and is highly recommended!
        if (sessionId) {
          const session = await stripe.checkout.sessions.retrieve(sessionId);
          if (session.payment_status !== "paid") {
            console.log(
              `Payment success update failed: Session ${sessionId} is not paid.`
            );
            return res
              .status(400)
              .send({ message: "Payment session status is not 'paid'." });
          }
        } else {
          console.log(
            "Warning: No session ID provided. Proceeding with client's payment success claim."
          );
        }

        // If verification passes (or is skipped), update the DB
        const result = await ordersCollection.updateOne(
          { _id: new ObjectId(orderId) },
          {
            $set: {
              payment_status: "paid",
              status: "processing", // Change fulfillment status
              stripeSessionId: sessionId || "N/A", // Save session ID
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
        res
          .status(500)
          .send({ message: "Failed to update order status.", error });
      }
    }); // --- ⭐ NEW ENDPOINT 3: CANCEL ORDER (PATCH) ---

    app.patch("/orders/cancel/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          status: "cancelled",
          payment_status: "cancelled",
        },
      };
      const result = await ordersCollection.updateOne(query, updateDoc);
      res.send(result);
    }); // --- ⭐ NEW ENDPOINT 4: UPDATE PAYMENT STATUS (PATCH) --- (Kept for completeness)

    app.patch("/orders/pay/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          payment_status: "paid",
          status: "processing",
        },
      };
      const result = await ordersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    //get all published books from db
    app.get("/books", async (req, res) => {
      const query = { status: "published" };
      const result = await booksCollection.find(query).toArray();
      res.send(result);
    });

    app.get("/latest-books", async (req, res) => {
      const limit = 6;
      const query = { status: "published" };
      const result = await booksCollection
        .find(query)
        .sort({ _id: -1 })
        .limit(limit)
        .toArray();

      res.send(result);
    }); //get a single book

    app.get("/books/:id", async (req, res) => {
      const id = req.params.id;
      const result = await booksCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // In your server.js or ordersRoutes.js

    app.get("/my-invoices/:email", async (req, res) => {
      const userEmail = req.params.email;
      if (!userEmail) {
        return res.status(400).send({ message: "Email required" });
      }

      try {
        const query = {
          email: userEmail,
          payment_status: "paid",
        };

        const invoices = await ordersCollection.find(query).toArray();
        res.send(invoices);
      } catch (error) {
        console.error("Error fetching invoices:", error);
        res.status(500).send({ message: "Failed to fetch paid orders." });
      }
    });

    // --- ⭐ NEW ENDPOINT: GET ALL BOOKS ADDED BY USER EMAIL (LIBRARIAN) ---
    app.get("/my-books/:email", async (req, res) => {
      const userEmail = req.params.email;

      if (!userEmail) {
        return res
          .status(400)
          .send({ message: "Email parameter is required." });
      }

      try {
        // Assuming the book data includes a field like 'authorEmail' or 'librarianEmail'
        // For simplicity, I will assume the book has an 'email' field storing the adder's email.
        const query = { "seller_libarien.email": userEmail };
        const myBooks = await booksCollection
          .find(query)
          .sort({ _id: -1 }) // Show latest added books first
          .toArray();

        res.send(myBooks);
      } catch (error) {
        console.error("Error fetching librarian's books:", error);
        res.status(500).send({ message: "Failed to fetch books." });
      }
    });

    // --- ⭐ NEW ENDPOINT: UPDATE BOOK STATUS (PUBLISH/UNPUBLISH) ---
    app.patch("/books/status/:id", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body; // Expecting status: 'published' or 'unpublished'

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

    // --- ⭐ NEW ENDPOINT: UPDATE BOOK BY ID (PATCH) ---
    app.patch("/books/:id", async (req, res) => {
      const id = req.params.id;
      const updatedBookData = req.body;

      // Remove _id from the body to prevent MongoDB error
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
