require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' });

app.post('/create-payment-intent', async (req, res) => {
  try {
    // Support creating a Subscription payment for existing subscription products
    // If you set STRIPE_MONTHLY_PRICE_ID and/or STRIPE_ANNUAL_PRICE_ID in your env,
    // pass { plan: 'monthly' } or { plan: 'annual' } in the request body and the
    // server will create a Subscription and return the client secret for the
    // first invoice's PaymentIntent so the client can collect payment.
    const { plan, email } = req.body || {};

    const monthlyPrice = process.env.STRIPE_MONTHLY_PRICE_ID;
    const annualPrice = process.env.STRIPE_ANNUAL_PRICE_ID;

    if (plan && (monthlyPrice || annualPrice)) {
      const chosenPriceId = plan === 'annual' ? annualPrice : monthlyPrice;
      if (!chosenPriceId) {
        return res.status(400).json({ error: 'Requested plan not configured on server' });
      }

      // Create or reuse a customer. If client provides `customerId`, reuse it.
      let customer = null;
      const { customerId, metadata } = req.body || {};
      if (customerId) {
        // Try to retrieve the existing customer to validate it
        try {
          customer = await stripe.customers.retrieve(customerId);
        } catch (e) {
          // If retrieval fails, create a new customer instead
          customer = null;
        }
      }
      if (!customer || customer.deleted) {
        customer = await stripe.customers.create({ email, metadata });
      }

      // Create subscription in incomplete state so we can collect payment for the first invoice
      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: chosenPriceId }],
        payment_behavior: 'default_incomplete',
        expand: ['latest_invoice.payment_intent'],
        metadata: metadata || {},
      });

      const paymentIntent = subscription.latest_invoice && subscription.latest_invoice.payment_intent;
      const clientSecret = paymentIntent ? paymentIntent.client_secret : null;
      // Return customerId so the client can store it and reuse in future
      return res.json({ clientSecret, subscriptionId: subscription.id, customerId: customer.id });
    }

    // Fallback: create a one-off PaymentIntent (useful if no price IDs are configured)
    // If client sent a plan but no price IDs are configured, we map to amounts here.
  const { amount, currency = 'brl' } = req.body;
    let intentAmount = amount;
    if (!intentAmount && plan) {
      intentAmount = plan === 'annual' ? 17990 : 1990;
    }
    // default amount if still not provided
    intentAmount = intentAmount || 1990;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: intentAmount,
      currency,
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Webhook endpoint to receive events from Stripe
// Use `stripe listen` locally or configure a webhook URL in the Stripe Dashboard.
// This endpoint verifies the Stripe signature using STRIPE_WEBHOOK_SECRET env var.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (!endpointSecret) {
      // If no webhook signing secret is set, parse without verification (not recommended for production)
      event = req.body && JSON.parse(req.body.toString());
    } else {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    }
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event types you care about
  switch (event.type) {
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      console.log('Invoice payment succeeded:', invoice.id);
      // TODO: mark subscription as active in your database
      break;
    }
    case 'customer.subscription.updated': {
      const subscription = event.data.object;
      console.log('Subscription updated:', subscription.id, subscription.status);
      // TODO: sync subscription status to your database
      break;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      console.log('Invoice payment failed:', invoice.id);
      // TODO: notify user or take action
      break;
    }
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});

const port = process.env.PORT || 4242;
app.listen(port, () => console.log(`Server listening on ${port}`));

