INSERT INTO shopify."Session" (
    id,
    shop,
    state,
    "isOnline",
    scope,
    expires,
    "accessToken",
    "userId",
    "firstName",
    "lastName",
    email,
    "accountOwner",
    locale,
    collaborator,
    "emailVerified",
    "refreshToken",
    "refreshTokenExpires"
)
VALUES (
    'offline_kwadwo-e4bf4mc4.myshopify.com',
    'kwadwo-e4bf4mc4.myshopify.com',
    '',                                      -- state: empty string, NOT NULL
    FALSE,
    'read_customers,read_orders,read_products',
    '2026-08-25 16:12:38.439',
    'YOUR_TOKEN_HERE',
    NULL,
    NULL,
    NULL,
    NULL,
    FALSE,
    NULL,
    FALSE,
    FALSE,
    'shprt_e606ae6954805cdd42186f9572d8cb72',
    '2026-11-23 15:12:38.439'
);