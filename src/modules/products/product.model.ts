import { model, Schema, type Types } from 'mongoose';

export interface ProductRecord {
  _id: Types.ObjectId;
  name: string;
  description: string;
  price: number;
  imageUrl: string;
  category: string;
  countInStock: number;
  rating: number;
  /** Number of reviews. */
  reviews: number;
  /** Admin who created the product. */
  user: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const productSchema = new Schema<ProductRecord>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    description: { type: String, required: true },
    price: { type: Number, required: true, min: 0, default: 0 },
    imageUrl: { type: String, required: true },
    category: { type: String, required: true, index: true },
    countInStock: { type: Number, required: true, min: 0, default: 0 },
    rating: { type: Number, required: true, min: 0, max: 5, default: 0 },
    reviews: { type: Number, required: true, min: 0, default: 0 },
    user: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  },
  { timestamps: true },
);

export const Product = model<ProductRecord>('Product', productSchema);
