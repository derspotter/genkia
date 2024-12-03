FROM node:lts-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

# Install system dependencies
RUN apk add --no-cache rsync openssh-client

# Create uploads directory
RUN mkdir -p /app/uploads

EXPOSE 3000

CMD ["node", "server.js"]
