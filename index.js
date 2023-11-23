const express = require('express');
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const jwt = require("jsonwebtoken");
const cors = require('cors');
const port = process.env.PORT | 5000;
const stripe = require("stripe")(process.env.DB_SECRET_KEY);

// middleware
app.use(cors());
app.use(express.json());

// verifyToken
const verifyToken = async (req, res, next) => {
    if (!req.headers.authorization) {
        return res.status(401).send({ message: "unauthorized access" })
    }
    const token = req.headers.authorization.split(" ")[1];
    jwt.verify(token, process.env.DB_ACCESS_TOKEN, (err, decoded) => {
        if (err) {
            return res.status(401).send({ message: "unauthorized access" })
        }
        req.decoded = decoded;
        next()
    })
}


const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.glcj3l3.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {

        const menuCollection = client.db("bistroDB").collection("menu");
        const userCollection = client.db("bistroDB").collection("users");
        const reviewCollection = client.db("bistroDB").collection("reviews");
        const cartsCollection = client.db("bistroDB").collection("carts");
        const paymentCollection = client.db("bistroDB").collection("payments");

        const verifyAdmin = async (req, res, next) => {
            const email = req.decoded.email;
            const query = { email: email }
            const user = await userCollection.findOne(query);
            const isAdmin = user?.role === "admin";
            if (!isAdmin) {
                return res.status(403).send({ message: "forbidden access" })
            }
            next();
        }

        app.get("/admin-stats", verifyToken, verifyAdmin, async (req, res) => {
            const users = await userCollection.estimatedDocumentCount();
            const menuItems = await menuCollection.estimatedDocumentCount();
            const paymentItems = await paymentCollection.estimatedDocumentCount();

            // not the best way cause using this way loads all data from mongodb
            // const revenue = await paymentCollection.find().toArray();
            // const total = revenue.reduce((previous, current)=> previous + current.price,0);

            const totalRevenue = await paymentCollection.aggregate([{
                $group: {
                    _id: null,
                    total: { $sum: "$price" }
                }
            }]).toArray();

            const revenue = totalRevenue.length > 0 ? totalRevenue[0].total : 0;

            res.send({ users, menuItems, paymentItems, revenue })
        })

        app.get("/order-stats", async (req, res) => {
            const result = await paymentCollection.aggregate([
                {
                    $unwind: "$menuIds"
                },
                {
                    $lookup: {
                        from: "menu",
                        let: { menuItemId: { $toObjectId: "$menuIds" } },
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ["$$menuItemId", "$_id"],
                                    },
                                },
                            },
                        ],
                        as: "menuItems",
                    }
                }
            ]).toArray();
            res.send(result);
        })

        app.post("/create-payment-intent", verifyToken, async (req, res) => {
            const { price } = req.body;
            const amount = parseInt(price * 100);
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: "usd",
                payment_method_types: ["card"],
            })
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        })

        app.get("/payments", verifyToken, async (req, res) => {
            const email = req?.query?.email;
            const query = { email: email }
            // const query = {email : req?.params?.email};
            if (email !== req?.decoded?.email) {
                res.status(403).send({ message: "forbidden access" });
            }
            const result = await paymentCollection.find(query).toArray();
            res.send(result);
        })

        app.post("/payments", verifyToken, async (req, res) => {
            const payment = req.body;
            const paymentResult = await paymentCollection.insertOne(payment);
            const query = {
                _id: {
                    $in: payment?.cartIds?.map(id => new ObjectId(id)),
                }
            }
            const deleteResult = await cartsCollection.deleteMany(query);
            res.send({ paymentResult, deleteResult });
        })

        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.DB_ACCESS_TOKEN, { expiresIn: "1h" });
            res.send({ token });
        })

        app.delete("/users/:id", verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await userCollection.deleteOne(query);
            res.send(result);
        })

        app.get("/users/admin/:email", verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: "forbidden access" });
            }
            const query = { email: email };
            const user = await userCollection.findOne(query);
            let admin = false;
            if (user) {
                admin = user?.role === "admin";
            }
            res.send({ admin });
        })

        app.patch("/users/admin/:id", verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    role: "admin"
                }
            }
            const result = await userCollection.updateOne(filter, updatedDoc);
            res.send(result);
        })

        app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
            const result = await userCollection.find().toArray();
            res.send(result);
        })

        app.post('/users', async (req, res) => {
            const user = req.body;
            const query = { email: user?.email };
            const existedUser = await userCollection.findOne(query);
            if (existedUser) {
                return res.send({ message: "user already exists", insertedId: null })
            }
            const result = await userCollection.insertOne(user);
            res.send(result);
        })

        app.get("/menu", async (req, res) => {
            const result = await menuCollection.find().toArray();
            res.send(result);
        })

        app.get("/menu/:id", async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await menuCollection.findOne(query);
            res.send(result);
        })

        app.patch("/menu/:id", async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const data = req.body;
            const updatedDoc = {
                $set: {
                    ...data
                }
            }
            const result = await menuCollection.updateOne(filter, updatedDoc);
            res.send(result);
        })

        app.post("/menu", verifyToken, verifyAdmin, async (req, res) => {
            const menuItem = req.body;
            const result = await menuCollection.insertOne(menuItem);
            res.send(result);
        })

        app.delete("/menu/:id", verifyToken, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await menuCollection.deleteOne(query);
            res.send(result)
        })

        app.get("/reviews", async (req, res) => {
            const result = await reviewCollection.find().toArray();
            res.send(result);
        })

        app.post('/carts', async (req, res) => {
            const body = req.body;
            const result = await cartsCollection.insertOne(body);
            res.send(result);
        })

        app.get('/carts', async (req, res) => {
            const email = req.query?.email;
            const query = { email: email };
            const result = await cartsCollection.find(query).toArray();
            res.send(result);
        })

        app.delete('/carts/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await cartsCollection.deleteOne(query);
            res.send(result);
        })

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {

    }
}
run().catch(console.dir);


app.get("/", (req, res) => {
    res.send("Boss is sitting")
})

app.listen(port, () => {
    console.log(`boss is sitting on port ${port}`);
})