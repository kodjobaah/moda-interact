FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

# Start the web runtime only. Database migration is a separate pre-deploy step
# (`npm run migrate`) and seeding is an explicit manual command (`npm run seed`);
# neither runs on a normal replica start, restart or scale-out.
CMD ["npm", "run", "start"]
