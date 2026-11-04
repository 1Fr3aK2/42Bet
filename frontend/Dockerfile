# ---------- Stage 1: build ----------
# Node + Vite are only used here, to turn the React code into static files.
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build
# Result: /app/dist (index.html + hashed JS/CSS files)

# ---------- Stage 2: serve ----------
# Small nginx image. It receives ONLY the dist/ folder from stage 1:
# no Node, no node_modules, no Vite.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]