```
                         Shop
                          │
      ┌───────────────────┼──────────────────┐
      │                   │                  │
ShopSettings        Subscription          Customer *
                         │                   │
                         │                   ▼
                     BillingPlan      CheckoutRecovery *
                         │
                         ▼
                    UsageEvent *

 ```

 ```
                          Shopify
                            │
                    App Pricing / Plans
                            │
                            ▼
                     moda-interact
                            │
                     BillingService
                            │
                  ┌─────────┴─────────┐
                  ▼                   ▼
            Subscription          BillingPlan
                  │
                  ▼
              PostgreSQL


        Application / Background Workers
                     │
          ┌──────────┴───────────┐
          ▼                      ▼
 EntitlementService          UsageService
                                  │
                                  ▼
                             UsageEvent
                                  │
                                  ▼
                              BullMQ
                                  │
                                  ▼
                           Billing Worker
                                  │
                                  ▼
                       Shopify App Events API

```