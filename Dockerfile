FROM node:20-alpine
RUN apk add --no-cache tzdata
WORKDIR /app
RUN npm install --omit=dev ws@8.18.3
COPY onvif.js .
CMD ["node", "onvif.js"]
