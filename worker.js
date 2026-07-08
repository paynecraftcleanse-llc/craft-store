export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://craftandcleanse.com",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // SIGNUP ROUTE
      if (url.pathname === "/api/signup" && request.method === "POST") {
        const { email, password } = await request.json();
        const userId = crypto.randomUUID();
        
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        await env.DB.prepare(
          "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)"
        ).bind(userId, email, passwordHash).run();

        return new Response(JSON.stringify({ success: true, userId }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // LOGIN ROUTE
      if (url.pathname === "/api/login" && request.method === "POST") {
        const { email, password } = await request.json();
        
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const passwordHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        const user = await env.DB.prepare(
          "SELECT * FROM users WHERE email = ? AND password_hash = ?"
        ).bind(email, passwordHash).first();

        if (!user) {
          return new Response(JSON.stringify({ error: "Invalid credentials" }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        return new Response(JSON.stringify({ success: true, userId: user.id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // SAVE CART ROUTE
      if (url.pathname === "/api/cart/save" && request.method === "POST") {
        const { userId, items } = await request.json();
        await env.DB.prepare("DELETE FROM cart_items WHERE user_id = ?").bind(userId).run();

        for (const item of items) {
          await env.DB.prepare(
            "INSERT INTO cart_items (user_id, product_id, variant_scent, quantity) VALUES (?, ?, ?, ?)"
          ).bind(userId, item.id, item.scent, item.quantity).run();
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // LOAD CART ROUTE
      if (url.pathname === "/api/cart/load" && request.method === "GET") {
        const userId = url.searchParams.get("userId");
        const rows = await env.DB.prepare("SELECT * FROM cart_items WHERE user_id = ?").bind(userId).all();
        
        return new Response(JSON.stringify({ success: true, items: rows.results }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

            // ROUTE 5: Create Secure Stripe Checkout Session (STRICT KEY-INDEX FORMAT COMPLIANCE)
      if (url.pathname === "/api/checkout" && request.method === "POST") {
        const { userId, items } = await request.json();
        
        let itemsSubtotalInPennies = 0;
        const lineItems = items.map(item => {
          itemsSubtotalInPennies += (2500 * item.quantity);
          return {
            name: item.id === "handmade-soap" ? "Handmade Soap" : "Artisan Candle",
            description: `Scent Selection: ${item.scent}`,
            amount: 2500,
            quantity: item.quantity
          };
        });

        const totalTaxInPennies = Math.round(itemsSubtotalInPennies * 0.06);
        lineItems.push({
          name: "Michigan Sales Tax (6%)",
          description: "State Sales Tax Assessment",
          amount: totalTaxInPennies,
          quantity: 1
        });

        lineItems.push({
          name: "USPS Flat Rate Shipping",
          description: "Separate Flat Rate Domestic Parcel",
          amount: 1500,
          quantity: 1
        });

        const bodyParams = new URLSearchParams();
        bodyParams.append("mode", "payment");
        bodyParams.append("success_url", "https://craftandcleanse.com");
        bodyParams.append("cancel_url", "https://craftandcleanse.com");
        bodyParams.append("client_reference_id", userId);
        
        // FIXED ARRAY FORMAT LOGIC FOR US SHIPPING RESTRICTIONS
        bodyParams.append("shipping_address_collection[allowed_countries][0]", "US");

        // Map items sequentially using explicit manual loop indexing that Stripe's form compiler natively reads
        lineItems.forEach((item, index) => {
          bodyParams.append(`line_items[${index}][price_data][currency]`, "usd");
          bodyParams.append(`line_items[${index}][price_data][unit_amount]`, item.amount.toString());
          bodyParams.append(`line_items[${index}][price_data][product_data][name]`, item.name);
          bodyParams.append(`line_items[${index}][price_data][product_data][description]`, item.description);
          bodyParams.append(`line_items[${index}][quantity]`, item.quantity.toString());
        });

        // FIXED: Switched back to standard urlencoded headers for global API mapping access
        const stripeResponse = await fetch("https://stripe.com", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: bodyParams.toString()
        });

        if (!stripeResponse.ok) {
          const stripeError = await stripeResponse.text();
          return new Response(JSON.stringify({ error: "Stripe System Message: " + stripeError }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const session = await stripeResponse.json();
        return new Response(JSON.stringify({ url: session.url }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }


      // STRIPE WEBHOOK ROUTE
      if (url.pathname === "/api/webhook" && request.method === "POST") {
        const payload = await request.text();
        const event = JSON.parse(payload);

        if (event.type === "charge.succeeded" || event.type === "checkout.session.completed") {
          const session = event.data.object;
          const orderId = "cc_" + crypto.randomUUID().substring(0, 8);
          const userId = session.client_reference_id || "guest_user";
          const totalPaid = session.amount_total ? (session.amount_total / 100) : 0;
          const addr = session.shipping_details?.address;
          const shippingString = addr 
            ? `${session.shipping_details.name}\n${addr.line1} ${addr.line2 || ""}\n${addr.city}, ${addr.state} ${addr.postal_code}`
            : "No Address Captured";

          await env.DB.prepare(
            "INSERT INTO orders (id, user_id, stripe_session_id, products_bought, total_amount, shipping_address, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(orderId, userId, session.id, "Store Order Items", totalPaid, shippingString, "Paid (Pending Shipment)").run();
        }
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }

      if (url.pathname === "/api/admin/orders" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
        return new Response(JSON.stringify({ success: true, orders: rows.results }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response(JSON.stringify({ error: "Endpoint Not Found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
