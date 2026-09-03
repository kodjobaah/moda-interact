FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --include=dev

COPY . .

RUN npm run build

ENV NODE_ENV=production

RUN npm cache clean --force

# Start the web runtime only. Database migration is a separate pre-deploy step
# (`npm run migrate`) and seeding is an explicit manual command (`npm run seed`);
# neither runs on a normal replica start, restart or scale-out.
CMD ["npm", "run", "start"]
